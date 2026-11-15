// Package tracking validates, projects, and appends a plan's tracking
// events: the append-only journey history kept in the `tracking` frontmatter
// key. Events are validated into a canonical key order so the YAML a plan
// stores and the JSON commands print are stable across writers.
package tracking

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"gopkg.in/yaml.v3"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

const SchemaVersion = 1

var (
	PlanStages          = []string{"planning", "awaiting_plan_review", "in_progress", "awaiting_pr_review", "completed"}
	Providers           = []string{"t3-code", "claude", "codex", "other"}
	ExecutionRoles      = []string{"planning", "implementation", "review"}
	EnvironmentTypes    = []string{"host", "vm", "container", "remote"}
	PrRoles             = []string{"implements", "partial", "followup", "supporting"}
	PrStates            = []string{"open", "draft", "closed", "merged"}
	EventTypes          = []string{"migrated", "stage", "session.attached", "session.ended", "pr.attached", "pr.detached", "pr.observed", "plan.review", "pr.review", "completed", "reopened"}
	PlanReviewDecisions = []string{"approved", "changes_requested"}
	PrReviewStates      = []string{"submitted", "requested", "approved", "changes_requested", "dismissed", "unknown"}
	ReopenStages        = []string{"in_progress", "planning"}
	EventSources        = []string{"cli", "server", "migration"}
	planStatuses        = []string{"active", "completed", "archived"}
)

// Limits bound how much tracking a plan may carry.
var Limits = struct{ Events, EventBytes, Text int }{500, 4096, 512}

// Error is a tracking failure. Code is the error code the TypeScript CLI
// used (ETRACKING, ECONFLICT, EDEPENDENCY, ...), which commands map to exit
// codes.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func fail(format string, args ...any) *Error {
	return &Error{Code: "ETRACKING", Msg: fmt.Sprintf(format, args...)}
}

// Errorf returns an error with the given code.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

var (
	uuidRe   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	shaRe    = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	digestRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	ctrlRe   = regexp.MustCompile(`[\x00-\x1f\x7f]`)
)

// jsLen is a string's length in UTF-16 code units, as JavaScript counts it.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

func record(value any, field string, allowed ...string) (*ordered.Obj, error) {
	o, ok := value.(*ordered.Obj)
	if !ok || o == nil {
		return nil, fail("%s must be an object", field)
	}
	for _, k := range o.Keys() {
		if !slices.Contains(allowed, k) {
			return nil, fail("%s has unsupported field \"%s\"", field, k)
		}
	}
	return o, nil
}

func text(value any, field string) (string, error) {
	s, ok := value.(string)
	if !ok || s == "" || jsLen(s) > Limits.Text {
		return "", fail("%s must be a non-empty string of at most %d characters", field, Limits.Text)
	}
	if ctrlRe.MatchString(s) {
		return "", fail("%s contains control characters", field)
	}
	return s, nil
}

func oneOf(value any, field string, values []string) (string, error) {
	s, ok := value.(string)
	if !ok || !slices.Contains(values, s) {
		return "", fail("%s must be one of: %s", field, strings.Join(values, ", "))
	}
	return s, nil
}

func uuid(value any, field string) (string, error) {
	s, ok := value.(string)
	if !ok || !uuidRe.MatchString(s) {
		return "", fail("%s must be a UUID", field)
	}
	return s, nil
}

var timestampLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05", "2006-01-02T15:04:05.000", "2006-01-02"}

func timestamp(value any, field string) (string, error) {
	if s, ok := value.(string); ok {
		for _, layout := range timestampLayouts {
			if _, err := time.Parse(layout, s); err == nil {
				return s, nil
			}
		}
	}
	return "", fail("%s must be an ISO timestamp", field)
}

func sha(value any, field string) (string, error) {
	s, ok := value.(string)
	if !ok || !shaRe.MatchString(s) {
		return "", fail("%s must be a hex commit SHA", field)
	}
	return s, nil
}

func digest(value any, field string) (string, error) {
	s, ok := value.(string)
	if !ok || !digestRe.MatchString(s) {
		return "", fail("%s must be a sha256 hex digest", field)
	}
	return s, nil
}

func integer(value any) (int64, bool) {
	switch t := value.(type) {
	case int64:
		return t, true
	case int:
		return int64(t), true
	case float64:
		if t == float64(int64(t)) {
			return int64(t), true
		}
	}
	return 0, false
}

// optional runs check on o[key] when present and sets the result on out.
func optional(out, o *ordered.Obj, key, field string, check func(any, string) (string, error)) error {
	v, ok := o.Get(key)
	if !ok {
		return nil
	}
	s, err := check(v, field)
	if err != nil {
		return err
	}
	out.Set(key, s)
	return nil
}

// required runs check on o[key] and sets the result on out.
func required(out, o *ordered.Obj, key, field string, check func(any, string) (string, error)) error {
	v, _ := o.Get(key)
	s, err := check(v, field)
	if err != nil {
		return err
	}
	out.Set(key, s)
	return nil
}

func oneOfCheck(values []string) func(any, string) (string, error) {
	return func(v any, field string) (string, error) { return oneOf(v, field, values) }
}

// BodyRevision is the reviewed plan revision. It covers only the body,
// since every tracking write changes the frontmatter; leading newlines are
// dropped because writers normalize the blank line after the frontmatter.
func BodyRevision(body string) string {
	sum := sha256.Sum256([]byte(strings.TrimLeft(body, "\n")))
	return hex.EncodeToString(sum[:])
}

func ValidateMachine(value any, field string) (*ordered.Obj, error) {
	raw, err := record(value, field, "installationId", "displayName", "hostname", "os", "arch")
	if err != nil {
		return nil, err
	}
	out := ordered.New()
	for _, step := range []struct {
		key   string
		check func(any, string) (string, error)
	}{{"installationId", uuid}, {"displayName", text}, {"hostname", text}, {"os", text}, {"arch", text}} {
		if err := required(out, raw, step.key, field+"."+step.key, step.check); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func ValidateEnvironment(value any, field string) (*ordered.Obj, error) {
	raw, err := record(value, field, "id", "type", "parentId")
	if err != nil {
		return nil, err
	}
	out := ordered.New()
	if err := required(out, raw, "id", field+".id", uuid); err != nil {
		return nil, err
	}
	if err := required(out, raw, "type", field+".type", oneOfCheck(EnvironmentTypes)); err != nil {
		return nil, err
	}
	if err := optional(out, raw, "parentId", field+".parentId", uuid); err != nil {
		return nil, err
	}
	return out, nil
}

func ValidateExecution(value any, field string) (*ordered.Obj, error) {
	raw, err := record(value, field, "id", "provider", "nativeSessionId", "providerNamespace", "role", "machine", "environment", "repository", "worktree", "branch", "commit")
	if err != nil {
		return nil, err
	}
	out := ordered.New()
	if err := required(out, raw, "id", field+".id", uuid); err != nil {
		return nil, err
	}
	if err := required(out, raw, "provider", field+".provider", oneOfCheck(Providers)); err != nil {
		return nil, err
	}
	// null means the provider gave no verified native ID; it is never guessed.
	if v, _ := raw.Get("nativeSessionId"); v == nil {
		out.Set("nativeSessionId", nil)
	} else if err := required(out, raw, "nativeSessionId", field+".nativeSessionId", text); err != nil {
		return nil, err
	}
	if err := optional(out, raw, "providerNamespace", field+".providerNamespace", text); err != nil {
		return nil, err
	}
	if err := required(out, raw, "role", field+".role", oneOfCheck(ExecutionRoles)); err != nil {
		return nil, err
	}
	m, _ := raw.Get("machine")
	machine, err := ValidateMachine(m, field+".machine")
	if err != nil {
		return nil, err
	}
	out.Set("machine", machine)
	e, _ := raw.Get("environment")
	env, err := ValidateEnvironment(e, field+".environment")
	if err != nil {
		return nil, err
	}
	out.Set("environment", env)
	for _, key := range []string{"repository", "worktree", "branch"} {
		if err := optional(out, raw, key, field+"."+key, text); err != nil {
			return nil, err
		}
	}
	if err := optional(out, raw, "commit", field+".commit", sha); err != nil {
		return nil, err
	}
	return out, nil
}

// PR is a canonical GitHub pull request identity.
type PR struct {
	Host   string
	Owner  string
	Repo   string
	Number int64
	URL    string
}

// Key identifies a PR regardless of URL letter case.
func (p PR) Key() string {
	return strings.ToLower(fmt.Sprintf("%s/%s/%s#%d", p.Host, p.Owner, p.Repo, p.Number))
}

var githubPRPath = regexp.MustCompile(`^/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]{0,9})/?$`)

// ParsePrURL accepts only canonical https://github.com pull request URLs.
// shortcut: only github.com is accepted; add an allowlist entry when a GitHub Enterprise host is needed.
func ParsePrURL(value string) (PR, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return PR{}, fail("Not a URL: %s", value)
	}
	if u.Scheme != "https" {
		return PR{}, fail("PR URL must use https")
	}
	if u.User != nil {
		return PR{}, fail("PR URL must not contain credentials")
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(value, "#") {
		return PR{}, fail("PR URL must not contain a query or fragment")
	}
	if strings.ToLower(u.Hostname()) != "github.com" || u.Port() != "" {
		return PR{}, fail("PR URL host must be github.com")
	}
	m := githubPRPath.FindStringSubmatch(u.EscapedPath())
	if m == nil {
		return PR{}, fail("PR URL must look like https://github.com/<owner>/<repo>/pull/<number>")
	}
	var n int64
	fmt.Sscanf(m[3], "%d", &n)
	return PR{Host: "github.com", Owner: m[1], Repo: m[2], Number: n, URL: fmt.Sprintf("https://github.com/%s/%s/pull/%s", m[1], m[2], m[3])}, nil
}

// PrObj is the validated `pr` object of a pr.attached event.
func PrObj(id string, pr PR, role string) *ordered.Obj {
	return ordered.New().Set("id", id).Set("host", pr.Host).Set("owner", pr.Owner).Set("repo", pr.Repo).Set("number", pr.Number).Set("url", pr.URL).Set("role", role)
}

func validatePr(value any, field string) (*ordered.Obj, error) {
	raw, err := record(value, field, "id", "host", "owner", "repo", "number", "url", "role")
	if err != nil {
		return nil, err
	}
	u, _ := raw.Get("url")
	urlText, err := text(u, field+".url")
	if err != nil {
		return nil, err
	}
	parsed, err := ParsePrURL(urlText)
	if err != nil {
		return nil, err
	}
	number, isInt := integer(must(raw.Get("number")))
	if raw.Str("host") != parsed.Host || raw.Str("owner") != parsed.Owner || raw.Str("repo") != parsed.Repo || !isInt || number != parsed.Number || urlText != parsed.URL {
		return nil, fail("%s identity does not match its canonical URL", field)
	}
	id, err := uuid(must(raw.Get("id")), field+".id")
	if err != nil {
		return nil, err
	}
	role, err := oneOf(must(raw.Get("role")), field+".role", PrRoles)
	if err != nil {
		return nil, err
	}
	return PrObj(id, parsed, role), nil
}

func must(v any, _ bool) any { return v }

// ValidateData validates the data of an event of the given type.
func ValidateData(eventType string, value any) (*ordered.Obj, error) {
	out := ordered.New()
	switch eventType {
	case "migrated":
		raw, err := record(value, "data", "stage", "fromStatus", "legacyCompletion")
		if err != nil {
			return nil, err
		}
		from, ok := must(raw.Get("fromStatus")).(string)
		if !ok || !slices.Contains(planStatuses, from) {
			return nil, fail("data.fromStatus must be a plan status")
		}
		legacy, ok := must(raw.Get("legacyCompletion")).(bool)
		if !ok {
			return nil, fail("data.legacyCompletion must be a boolean")
		}
		if err := required(out, raw, "stage", "data.stage", oneOfCheck(PlanStages)); err != nil {
			return nil, err
		}
		return out.Set("fromStatus", from).Set("legacyCompletion", legacy), nil
	case "stage":
		raw, err := record(value, "data", "stage", "reason", "bodyRevision")
		if err != nil {
			return nil, err
		}
		if err := required(out, raw, "stage", "data.stage", oneOfCheck(PlanStages)); err != nil {
			return nil, err
		}
		if err := optional(out, raw, "reason", "data.reason", text); err != nil {
			return nil, err
		}
		return out, optional(out, raw, "bodyRevision", "data.bodyRevision", digest)
	case "session.attached":
		raw, err := record(value, "data", "execution")
		if err != nil {
			return nil, err
		}
		exec, err := ValidateExecution(must(raw.Get("execution")), "execution")
		if err != nil {
			return nil, err
		}
		return out.Set("execution", exec), nil
	case "session.ended":
		raw, err := record(value, "data", "executionId")
		if err != nil {
			return nil, err
		}
		return out, required(out, raw, "executionId", "data.executionId", uuid)
	case "pr.attached":
		raw, err := record(value, "data", "pr")
		if err != nil {
			return nil, err
		}
		pr, err := validatePr(must(raw.Get("pr")), "pr")
		if err != nil {
			return nil, err
		}
		return out.Set("pr", pr), nil
	case "pr.detached":
		raw, err := record(value, "data", "prId")
		if err != nil {
			return nil, err
		}
		return out, required(out, raw, "prId", "data.prId", uuid)
	case "pr.observed":
		raw, err := record(value, "data", "prId", "state", "headSha", "mergeSha")
		if err != nil {
			return nil, err
		}
		if err := required(out, raw, "prId", "data.prId", uuid); err != nil {
			return nil, err
		}
		if err := required(out, raw, "state", "data.state", oneOfCheck(PrStates)); err != nil {
			return nil, err
		}
		if err := optional(out, raw, "headSha", "data.headSha", sha); err != nil {
			return nil, err
		}
		return out, optional(out, raw, "mergeSha", "data.mergeSha", sha)
	case "plan.review":
		raw, err := record(value, "data", "decision", "bodyRevision")
		if err != nil {
			return nil, err
		}
		if err := required(out, raw, "decision", "data.decision", oneOfCheck(PlanReviewDecisions)); err != nil {
			return nil, err
		}
		return out, required(out, raw, "bodyRevision", "data.bodyRevision", digest)
	case "pr.review":
		raw, err := record(value, "data", "prId", "state", "headSha")
		if err != nil {
			return nil, err
		}
		if !raw.Has("headSha") {
			return nil, fail("data.headSha is required")
		}
		if err := required(out, raw, "prId", "data.prId", uuid); err != nil {
			return nil, err
		}
		if err := required(out, raw, "state", "data.state", oneOfCheck(PrReviewStates)); err != nil {
			return nil, err
		}
		return out, required(out, raw, "headSha", "data.headSha", sha)
	case "completed":
		raw, err := record(value, "data", "reason", "noPrRationale", "coveredPrIds")
		if err != nil {
			return nil, err
		}
		ids, ok := must(raw.Get("coveredPrIds")).([]any)
		if !ok {
			return nil, fail("data.coveredPrIds must be an array")
		}
		if err := required(out, raw, "reason", "data.reason", text); err != nil {
			return nil, err
		}
		if err := optional(out, raw, "noPrRationale", "data.noPrRationale", text); err != nil {
			return nil, err
		}
		covered := make([]any, 0, len(ids))
		for i, id := range ids {
			s, err := uuid(id, fmt.Sprintf("data.coveredPrIds[%d]", i))
			if err != nil {
				return nil, err
			}
			covered = append(covered, s)
		}
		return out.Set("coveredPrIds", covered), nil
	case "reopened":
		raw, err := record(value, "data", "stage", "reason")
		if err != nil {
			return nil, err
		}
		if err := required(out, raw, "stage", "data.stage", oneOfCheck(ReopenStages)); err != nil {
			return nil, err
		}
		return out, required(out, raw, "reason", "data.reason", text)
	}
	return nil, fail("unknown event type %q", eventType)
}

// Event is a validated tracking event. Optional string fields are empty
// when absent.
type Event struct {
	ID             string
	Seq            int64
	Type           string
	Actor          string
	Source         string
	RecordedAt     string
	ObservedAt     string
	IdempotencyKey string
	Evidence       string
	Revokes        string
	Data           *ordered.Obj
}

// Obj returns the event in its canonical key order.
func (e *Event) Obj() *ordered.Obj {
	return ordered.New().Set("id", e.ID).Set("seq", e.Seq).Set("type", e.Type).Set("schemaVersion", int64(SchemaVersion)).
		Set("actor", e.Actor).Set("source", e.Source).Set("recordedAt", e.RecordedAt).
		SetIf(e.ObservedAt != "", "observedAt", e.ObservedAt).
		SetIf(e.IdempotencyKey != "", "idempotencyKey", e.IdempotencyKey).
		SetIf(e.Evidence != "", "evidence", e.Evidence).
		SetIf(e.Revokes != "", "revokes", e.Revokes).
		Set("data", e.Data)
}

func (e *Event) MarshalJSON() ([]byte, error) { return e.Obj().MarshalJSON() }

// effectiveAt is when the event happened: its observation time if given.
func (e *Event) effectiveAt() string {
	if e.ObservedAt != "" {
		return e.ObservedAt
	}
	return e.RecordedAt
}

func ValidateEvent(value any, field string) (*Event, error) {
	raw, err := record(value, field, "id", "seq", "type", "schemaVersion", "actor", "source", "recordedAt", "observedAt", "idempotencyKey", "evidence", "revokes", "data")
	if err != nil {
		return nil, err
	}
	if v, ok := integer(must(raw.Get("schemaVersion"))); !ok || v != SchemaVersion {
		return nil, fail("%s.schemaVersion %s is not supported", field, jsString(must(raw.Get("schemaVersion"))))
	}
	seq, ok := integer(must(raw.Get("seq")))
	if !ok || seq < 1 {
		return nil, fail("%s.seq must be a positive integer", field)
	}
	e := &Event{Seq: seq}
	if e.Type, err = oneOf(must(raw.Get("type")), field+".type", EventTypes); err != nil {
		return nil, err
	}
	if e.ID, err = uuid(must(raw.Get("id")), field+".id"); err != nil {
		return nil, err
	}
	if e.Actor, err = text(must(raw.Get("actor")), field+".actor"); err != nil {
		return nil, err
	}
	if e.Source, err = oneOf(must(raw.Get("source")), field+".source", EventSources); err != nil {
		return nil, err
	}
	if e.RecordedAt, err = timestamp(must(raw.Get("recordedAt")), field+".recordedAt"); err != nil {
		return nil, err
	}
	for _, opt := range []struct {
		key   string
		dst   *string
		check func(any, string) (string, error)
	}{{"observedAt", &e.ObservedAt, timestamp}, {"idempotencyKey", &e.IdempotencyKey, text}, {"evidence", &e.Evidence, text}, {"revokes", &e.Revokes, uuid}} {
		if v, ok := raw.Get(opt.key); ok {
			if *opt.dst, err = opt.check(v, field+"."+opt.key); err != nil {
				return nil, err
			}
		}
	}
	if e.Data, err = ValidateData(e.Type, must(raw.Get("data"))); err != nil {
		return nil, err
	}
	if jsLen(ordered.JSON(e.Obj())) > Limits.EventBytes {
		return nil, fail("%s exceeds %d bytes", field, Limits.EventBytes)
	}
	return e, nil
}

func jsString(v any) string {
	if v == nil {
		return "undefined"
	}
	return fmt.Sprint(v)
}

// Tracking is a plan's validated event history.
type Tracking struct{ Events []*Event }

func ValidateTracking(value any) (*Tracking, error) {
	raw, err := record(value, "tracking", "events")
	if err != nil {
		return nil, err
	}
	list, ok := must(raw.Get("events")).([]any)
	if !ok {
		return nil, fail("tracking.events must be an array")
	}
	if len(list) > Limits.Events {
		return nil, fail("tracking has more than %d events", Limits.Events)
	}
	ids, keys := map[string]bool{}, map[string]bool{}
	t := &Tracking{}
	for i, item := range list {
		field := fmt.Sprintf("tracking.events[%d]", i)
		e, err := ValidateEvent(item, field)
		if err != nil {
			return nil, err
		}
		if e.Seq != int64(i+1) {
			return nil, fail("%s.seq must be %d", field, i+1)
		}
		if ids[e.ID] {
			return nil, fail("%s.id is duplicated", field)
		}
		if e.IdempotencyKey != "" && keys[e.IdempotencyKey] {
			return nil, fail("%s.idempotencyKey is duplicated", field)
		}
		ids[e.ID] = true
		if e.IdempotencyKey != "" {
			keys[e.IdempotencyKey] = true
		}
		t.Events = append(t.Events, e)
	}
	return t, nil
}

// Obj returns the tracking block in canonical form.
func (t *Tracking) Obj() *ordered.Obj {
	events := make([]any, len(t.Events))
	for i, e := range t.Events {
		events[i] = e.Obj()
	}
	return ordered.New().Set("events", events)
}

// YAML returns the tracking block as a frontmatter value.
func (t *Tracking) YAML() *yaml.Node { return ordered.ToYAML(t.Obj()) }

// Source is the part of a plan's metadata that tracking reads.
type Source struct {
	ID            string
	Status        string
	SchemaVersion *int
	Raw           *yaml.Node
}

// Read validates a plan's tracking block; it returns nil for untracked plans.
func Read(src Source) (*Tracking, error) {
	if src.SchemaVersion != nil && *src.SchemaVersion > SchemaVersion {
		return nil, Errorf("EUNSUPPORTEDSCHEMA", "Plan %s uses tracking schema %d; upgrade plan to edit it", src.ID, *src.SchemaVersion)
	}
	if src.Raw == nil {
		return nil, nil
	}
	return ValidateTracking(ordered.FromYAML(src.Raw))
}

// Execution is a projected agent session.
type Execution struct {
	ID              string
	AttachedEventID string
	StartedAt       string
	EndedAt         string
	Data            *ordered.Obj
}

type Observation struct {
	State      string
	HeadSha    string
	MergeSha   string
	ObservedAt string
}

type Review struct {
	State      string
	ReviewedAt string
}

type PrReview struct {
	State      string
	HeadSha    string
	ReviewedAt string
	Stale      bool
}

// ProjectedPR is an attached PR with its latest observation and reviews.
type ProjectedPR struct {
	PR
	ID              string
	Role            string
	AttachedEventID string
	AttachedAt      string
	Observed        *Observation
	// Latest review per head SHA; Review is the one for the observed head, or
	// the latest one marked stale.
	Reviews map[string]Review
	Review  *PrReview
}

// Approval is the state of the plan review. BodyRevision is empty when no
// revision was submitted; Stale is only known when the body is supplied.
type Approval struct {
	State        string
	BodyRevision string
	Stale        bool
}

type Projection struct {
	Stage string
	// True when completion predates tracking, so its review gates are
	// unknown rather than satisfied.
	LegacyCompletion bool
	Executions       []*Execution
	PRs              []*ProjectedPR
	PlanApproval     Approval
}

func legacyStage(status string) (string, bool) {
	if status == "completed" {
		return "completed", true
	}
	return "planning", false
}

// ProjectEvents folds events into the current journey state. Pass body to
// learn whether the plan approval is stale.
func ProjectEvents(events []*Event, status string, body *string) *Projection {
	p := &Projection{PlanApproval: Approval{State: "none"}}
	p.Stage, p.LegacyCompletion = legacyStage(status)
	findPR := func(id string) *ProjectedPR {
		for _, pr := range p.PRs {
			if pr.ID == id {
				return pr
			}
		}
		return nil
	}
	for _, e := range events {
		d := e.Data
		switch e.Type {
		case "migrated":
			p.Stage = d.Str("stage")
			p.LegacyCompletion, _ = must(d.Get("legacyCompletion")).(bool)
		case "stage":
			p.Stage = d.Str("stage")
			p.LegacyCompletion = false
			// A submission opens a new review of exactly this body revision.
			if p.Stage == "awaiting_plan_review" {
				p.PlanApproval = Approval{State: "pending", BodyRevision: d.Str("bodyRevision")}
			}
		case "session.attached":
			exec, _ := must(d.Get("execution")).(*ordered.Obj)
			p.Executions = append(p.Executions, &Execution{ID: exec.Str("id"), AttachedEventID: e.ID, StartedAt: e.effectiveAt(), Data: exec})
		case "session.ended":
			for _, x := range p.Executions {
				if x.ID == d.Str("executionId") {
					x.EndedAt = e.effectiveAt()
				}
			}
		case "pr.attached":
			pr, _ := must(d.Get("pr")).(*ordered.Obj)
			number, _ := integer(must(pr.Get("number")))
			p.PRs = append(p.PRs, &ProjectedPR{
				PR: PR{Host: pr.Str("host"), Owner: pr.Str("owner"), Repo: pr.Str("repo"), Number: number, URL: pr.Str("url")},
				ID: pr.Str("id"), Role: pr.Str("role"), AttachedEventID: e.ID, AttachedAt: e.RecordedAt, Reviews: map[string]Review{},
			})
		case "pr.detached":
			p.PRs = slices.DeleteFunc(p.PRs, func(pr *ProjectedPR) bool { return pr.ID == d.Str("prId") })
		case "pr.observed":
			if pr := findPR(d.Str("prId")); pr != nil {
				pr.Observed = &Observation{State: d.Str("state"), HeadSha: d.Str("headSha"), MergeSha: d.Str("mergeSha"), ObservedAt: e.effectiveAt()}
			}
		case "plan.review":
			p.PlanApproval = Approval{State: d.Str("decision"), BodyRevision: d.Str("bodyRevision")}
			if d.Str("decision") == "changes_requested" {
				p.Stage = "planning"
			}
		case "pr.review":
			if pr := findPR(d.Str("prId")); pr != nil {
				at := e.effectiveAt()
				pr.Reviews[d.Str("headSha")] = Review{State: d.Str("state"), ReviewedAt: at}
				pr.Review = &PrReview{State: d.Str("state"), HeadSha: d.Str("headSha"), ReviewedAt: at}
			}
		case "completed":
			p.Stage = "completed"
			p.LegacyCompletion = false
		case "reopened":
			p.Stage = d.Str("stage")
			p.LegacyCompletion = false
		}
	}
	for _, pr := range p.PRs {
		head := ""
		if pr.Observed != nil {
			head = pr.Observed.HeadSha
		}
		if r, ok := pr.Reviews[head]; head != "" && ok {
			pr.Review = &PrReview{State: r.State, HeadSha: head, ReviewedAt: r.ReviewedAt}
		} else if pr.Review != nil && head != "" {
			pr.Review.Stale = true
		}
	}
	if body != nil && p.PlanApproval.BodyRevision != "" {
		p.PlanApproval.Stale = p.PlanApproval.BodyRevision != BodyRevision(*body)
	}
	return p
}

// Project reads and projects a plan's tracking.
func Project(src Source, body *string) (*Projection, error) {
	t, err := Read(src)
	if err != nil {
		return nil, err
	}
	var events []*Event
	if t != nil {
		events = t.Events
	}
	return ProjectEvents(events, src.Status, body), nil
}

// SafeStage is nil when tracking cannot be read, so callers show the stage
// as unknown instead of guessing.
func SafeStage(src Source) *string {
	p, err := Project(src, nil)
	if err != nil {
		return nil
	}
	return &p.Stage
}

// AssertStageMatchesStatus refuses a status that contradicts the tracked
// stage. Archived is a storage disposition, so only active/completed must
// agree with the stage.
func AssertStageMatchesStatus(src Source) error {
	if src.Raw == nil || src.Status == "archived" {
		return nil
	}
	p, err := Project(src, nil)
	if err != nil {
		return nil
	}
	if (p.Stage == "completed") != (src.Status == "completed") {
		return Errorf("ESTAGECONFLICT", "Status \"%s\" contradicts tracked stage \"%s\"; change it with plan stage, plan complete or plan reopen", src.Status, p.Stage)
	}
	return nil
}

// Guards for the journey trigger table. Callers pass a projection built
// with the current body so staleness is known.
var stageSources = map[string][]string{
	"planning":             {"awaiting_plan_review", "in_progress", "awaiting_pr_review"},
	"awaiting_plan_review": {"planning"},
	"in_progress":          {"planning", "awaiting_plan_review", "awaiting_pr_review"},
	"awaiting_pr_review":   {"in_progress"},
	"completed":            {},
}

func assertCurrentApproval(p *Projection, action string) error {
	if p.PlanApproval.State != "approved" {
		return fail("%s requires an approved plan review (plan review record <id> plan --decision approved)", action)
	}
	if p.PlanApproval.Stale {
		return fail("%s requires a current plan approval; the plan body changed after approval, so resubmit it for review", action)
	}
	return nil
}

// AssertStageTransition returns false when the plan is already in the
// target stage, so retries record nothing.
func AssertStageTransition(p *Projection, target string) (bool, error) {
	from := p.Stage
	if target == "completed" {
		return false, fail("Use plan complete to complete a plan; it checks plan approval and PR disposition")
	}
	if from == "completed" {
		return false, fail("Use plan reopen to move a completed plan back to work")
	}
	// Resubmitting is the one same-stage change: the body changed since the
	// pending submission.
	if from == target {
		return target == "awaiting_plan_review" && p.PlanApproval.Stale, nil
	}
	if !slices.Contains(stageSources[target], from) {
		return false, fail("Cannot move from %s to %s", from, target)
	}
	if target == "in_progress" {
		if err := assertCurrentApproval(p, "Starting work"); err != nil {
			return false, err
		}
	}
	if target == "awaiting_pr_review" && !slices.ContainsFunc(p.PRs, func(pr *ProjectedPR) bool { return pr.Observed != nil && pr.Observed.State == "open" }) {
		return false, fail("awaiting_pr_review requires an attached PR open for review (a draft PR does not count); run plan pr attach or plan pr refresh")
	}
	return true, nil
}

func AssertPlanReview(p *Projection) error {
	if p.Stage != "awaiting_plan_review" {
		return fail("Plan reviews are recorded in awaiting_plan_review, not %s; submit with plan stage <id> awaiting_plan_review", p.Stage)
	}
	if p.PlanApproval.Stale {
		return fail("The plan body changed since it was submitted; resubmit with plan stage <id> awaiting_plan_review")
	}
	return nil
}

// AssertCompletion returns the implementing PR IDs that the completion covers.
func AssertCompletion(p *Projection, noPrRationale string) ([]string, error) {
	if p.Stage != "in_progress" && p.Stage != "awaiting_pr_review" {
		return nil, fail("Cannot complete from %s", p.Stage)
	}
	if err := assertCurrentApproval(p, "Completing"); err != nil {
		return nil, err
	}
	if len(p.PRs) == 0 {
		if noPrRationale == "" {
			return nil, fail("No PRs are attached; completing requires --no-pr-rationale <text>")
		}
		return []string{}, nil
	}
	if noPrRationale != "" {
		return nil, fail("--no-pr-rationale is only for plans without attached PRs")
	}
	ids := []string{}
	for _, pr := range p.PRs {
		if pr.Role != "implements" {
			continue
		}
		if pr.Observed == nil || pr.Observed.State != "merged" {
			state := "not observed"
			if pr.Observed != nil {
				state = pr.Observed.State
			}
			return nil, fail("%s is %s, not merged; run plan pr refresh", pr.URL, state)
		}
		if pr.Review == nil || pr.Review.State != "approved" || pr.Review.Stale {
			return nil, fail("%s has no approved review of its current head; record one with plan review record <id> pr", pr.URL)
		}
		ids = append(ids, pr.ID)
	}
	if len(ids) == 0 {
		return nil, fail("Only partial, followup or supporting PRs are attached; attach the implementing PR with --role implements")
	}
	return ids, nil
}

func AssertReopen(p *Projection, target string) error {
	if p.Stage != "completed" {
		return fail("Only completed plans can be reopened; this plan is %s", p.Stage)
	}
	if target == "in_progress" {
		return assertCurrentApproval(p, "Reopening into in_progress")
	}
	return nil
}

// EventInput is a change to append. Empty optional fields are omitted.
type EventInput struct {
	Type           string
	Data           *ordered.Obj
	Actor          string
	Source         string
	ObservedAt     string
	IdempotencyKey string
	Evidence       string
	Revokes        string
}

// Appended is the result of Append.
type Appended struct {
	Tracking  *Tracking
	Status    string
	Event     *Event
	Duplicate bool
}

// NewUUID returns a random version 4 UUID.
func NewUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func isoNow(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

// Append validates input and appends it to the plan's events. A retry with a
// used idempotency key returns the prior event as a duplicate, or ECONFLICT
// when it describes a different change. The first event of an untracked
// plan is preceded by a migration event recording its legacy status.
func Append(src Source, input EventInput, now time.Time) (*Appended, error) {
	existing, err := Read(src)
	if err != nil {
		return nil, err
	}
	if input.IdempotencyKey != "" && existing != nil {
		for _, prior := range existing.Events {
			if prior.IdempotencyKey != input.IdempotencyKey {
				continue
			}
			data, err := ValidateData(input.Type, input.Data)
			if err != nil {
				return nil, err
			}
			if prior.Type != input.Type || ordered.JSON(prior.Data) != ordered.JSON(data) {
				return nil, Errorf("ECONFLICT", "Idempotency key \"%s\" was already used for a different change", input.IdempotencyKey)
			}
			return &Appended{Tracking: existing, Status: src.Status, Event: prior, Duplicate: true}, nil
		}
	}
	recordedAt := isoNow(now)
	var events []any
	if existing != nil {
		for _, e := range existing.Events {
			events = append(events, e.Obj())
		}
	}
	if len(events) == 0 {
		stage, legacy := legacyStage(src.Status)
		events = append(events, ordered.New().Set("id", NewUUID()).Set("seq", int64(1)).Set("type", "migrated").
			Set("schemaVersion", int64(SchemaVersion)).Set("actor", input.Actor).Set("source", "migration").Set("recordedAt", recordedAt).
			Set("data", ordered.New().Set("stage", stage).Set("legacyCompletion", legacy).Set("fromStatus", src.Status)))
	}
	source := input.Source
	if source == "" {
		source = "cli"
	}
	data := any(input.Data)
	if input.Data == nil {
		data = nil
	}
	events = append(events, ordered.New().Set("id", NewUUID()).Set("seq", int64(len(events)+1)).
		Set("schemaVersion", int64(SchemaVersion)).Set("source", source).Set("recordedAt", recordedAt).
		Set("type", input.Type).Set("data", data).Set("actor", input.Actor).
		SetIf(input.ObservedAt != "", "observedAt", input.ObservedAt).
		SetIf(input.IdempotencyKey != "", "idempotencyKey", input.IdempotencyKey).
		SetIf(input.Evidence != "", "evidence", input.Evidence).
		SetIf(input.Revokes != "", "revokes", input.Revokes))
	t, err := ValidateTracking(ordered.New().Set("events", events))
	if err != nil {
		return nil, err
	}
	status := "active"
	if src.Status == "archived" {
		status = "archived"
	} else if ProjectEvents(t.Events, src.Status, nil).Stage == "completed" {
		status = "completed"
	}
	return &Appended{Tracking: t, Status: status, Event: t.Events[len(t.Events)-1]}, nil
}

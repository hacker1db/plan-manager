package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/ordered"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/tracking"
)

// trackingExits maps tracking error codes to exit codes.
var trackingExits = map[string]int{
	"ECONFLICT": exitcode.Conflict, "ETRACKING": exitcode.InvalidInput, "ESTAGECONFLICT": exitcode.InvalidInput,
	"EUNSUPPORTEDSCHEMA": exitcode.InvalidInput, "EDEPENDENCY": exitcode.DependencyUnavailable, "ENOTFOUND": exitcode.NotFound,
}

// exitFor converts tracking errors into exit-code errors; others pass through.
func exitFor(err error) error {
	var te *tracking.Error
	if errors.As(err, &te) {
		if code, ok := trackingExits[te.Code]; ok {
			return exitcode.New(code, "%s", te.Msg)
		}
	}
	return err
}

// trackingOpts are the flags every tracking command accepts.
type trackingOpts struct {
	*options
	ifRevision, idempotencyKey, actor, evidence string
}

func addTrackingFlags(c *cobra.Command, t *trackingOpts) {
	c.Flags().StringVar(&t.ifRevision, "if-revision", "", "only write if the file still has this revision")
	c.Flags().StringVar(&t.idempotencyKey, "idempotency-key", "", "make retries of this change record it once")
	c.Flags().StringVar(&t.actor, "actor", "", "who made the change (default: the OS user)")
	c.Flags().StringVar(&t.evidence, "evidence", "", "reference that supports the change")
	for _, name := range []string{"idempotency-key", "actor", "evidence"} {
		_ = c.RegisterFlagCompletionFunc(name, cobra.NoFileCompletions)
	}
}

func (t *trackingOpts) actorName() string {
	if t.actor != "" {
		return t.actor
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return os.Getenv("USER")
}

// entityID derives the ID of an attached session or PR. Retried calls with
// the same idempotency key must produce the same ID so the retry is
// recognized as a duplicate.
func entityID(planID, key string) string {
	if key == "" {
		return tracking.NewUUID()
	}
	sum := sha256.Sum256([]byte(planID + "\x00" + key))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}

// mutation is what a tracking command decides to do with the current plan:
// append input, or report result without writing.
type mutation struct {
	input  *tracking.EventInput
	result *ordered.Obj
}

type outcome struct {
	envelope  plans.Envelope
	event     *tracking.Event
	duplicate bool
	result    *ordered.Obj
}

// mutate applies one tracking change to a plan under the write lock.
func mutate(idOrSlug, ifRevision string, build func(p *plans.Plan) (mutation, error)) (*outcome, error) {
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	return lock.With(plans.Home(), func() (*outcome, error) {
		p, err := resolveContained(idOrSlug)
		if err != nil {
			return nil, err
		}
		if ifRevision != "" && p.Revision() != ifRevision {
			return nil, &exitcode.Error{Code: exitcode.Conflict, Raw: true, Msg: conflictJSON(p.Revision(), ifRevision)}
		}
		m, err := build(p)
		if err != nil {
			return nil, exitFor(err)
		}
		if m.input == nil {
			return &outcome{envelope: p.Envelope(), duplicate: true, result: m.result}, nil
		}
		appended, err := tracking.Append(p.Meta.TrackingSource(), *m.input, time.Now())
		if err != nil {
			return nil, exitFor(err)
		}
		if appended.Duplicate {
			return &outcome{envelope: p.Envelope(), event: appended.Event, duplicate: true}, nil
		}
		meta := p.Meta
		version := tracking.SchemaVersion
		meta.Status, meta.SchemaVersion, meta.Tracking = appended.Status, &version, appended.Tracking.YAML()
		if err := plans.Write(p.FilePath, meta, p.Body); err != nil {
			return nil, err
		}
		np, err := plans.Read(p.FilePath)
		if err != nil {
			return nil, err
		}
		return &outcome{envelope: np.Envelope(), event: appended.Event}, nil
	})
}

func envelopeObj(env plans.Envelope) *ordered.Obj {
	data, _ := json.Marshal(env)
	v, _ := ordered.DecodeJSON(data)
	return v.(*ordered.Obj)
}

// report prints the outcome: the envelope plus extra fields, the event, and
// whether the change was a duplicate.
func report(c *cobra.Command, t *trackingOpts, o *outcome, extra *ordered.Obj, summary string) error {
	if t.json {
		out := envelopeObj(o.envelope).Merge(extra)
		if o.event != nil {
			out.Set("event", o.event.Obj())
		}
		out.Set("duplicate", o.duplicate)
		if o.result != nil {
			out.Merge(o.result)
		}
		return writeJSON(c.OutOrStdout(), out)
	}
	if o.duplicate {
		summary = "Unchanged"
	}
	fmt.Fprintf(c.OutOrStdout(), "%s\n  revision: %s\n", summary, o.envelope.Revision)
	return nil
}

func project(p *plans.Plan, withBody bool) (*tracking.Projection, error) {
	var body *string
	if withBody {
		body = &p.Body
	}
	return tracking.Project(p.Meta.TrackingSource(), body)
}

func (t *trackingOpts) event(eventType string, data *ordered.Obj) *tracking.EventInput {
	return &tracking.EventInput{Type: eventType, Data: data, Actor: t.actorName(), IdempotencyKey: t.idempotencyKey, Evidence: t.evidence}
}

// ---------- plan session ----------

const sessionUsage = "Usage: plan session <attach|end> <id-or-slug> ..."

var sessionInputFields = []string{"provider", "nativeSessionId", "providerNamespace", "role", "repository", "worktree", "branch", "commit", "environment", "observedAt", "idempotencyKey", "evidence"}

func readJSONInput(stdin bool, file string) (*ordered.Obj, error) {
	var data []byte
	var err error
	switch {
	case stdin:
		data, err = io.ReadAll(os.Stdin)
	case file != "":
		if data, err = os.ReadFile(file); err != nil {
			return nil, invalid("reading file: %s", err.Error())
		}
	default:
		return nil, invalid("session details are required as JSON via --stdin or --file")
	}
	if err != nil {
		return nil, err
	}
	v, err := ordered.DecodeJSON(data)
	if err != nil {
		return nil, invalid("session details must be valid JSON")
	}
	o, ok := v.(*ordered.Obj)
	if !ok {
		return nil, invalid("session details must be a JSON object")
	}
	return o, nil
}

// environmentFor is the environment a session ran in. A VM, container, or
// remote environment is a different executor from its controller, so it
// needs its own ID and records the host as its parent.
func environmentFor(value any, present bool, host *ordered.Obj) (*ordered.Obj, error) {
	if !present {
		return host, nil
	}
	raw, ok := value.(*ordered.Obj)
	if !ok {
		return tracking.ValidateEnvironment(value, "environment")
	}
	if raw.Str("type") == "host" && !raw.Has("id") {
		return host, nil
	}
	env := ordered.New().Merge(raw)
	if raw.Str("type") != "host" && !raw.Has("parentId") {
		env.Set("parentId", host.Str("id"))
	}
	return tracking.ValidateEnvironment(env, "environment")
}

// inputString reads an optional string field of the session JSON. A
// non-string value fails the same validation the event would apply.
func inputString(input *ordered.Obj, key, message string) (string, error) {
	v, ok := input.Get(key)
	if !ok {
		return "", nil
	}
	s, isString := v.(string)
	if !isString {
		return "", tracking.Errorf("ETRACKING", "event.%s %s", key, message)
	}
	return s, nil
}

func newSessionCmd(opts *options) *cobra.Command {
	session := &cobra.Command{
		Use:   "session <attach|end> <id-or-slug> ...",
		Short: "Attach or end an agent session on a plan",
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) < 2 {
				return invalid("%s", sessionUsage)
			}
			return invalid("Unknown session subcommand: %s\n  %s", args[0], sessionUsage)
		},
	}

	attachOpts := &trackingOpts{options: opts}
	var stdin bool
	var file, role string
	attach := &cobra.Command{
		Use:               "attach <id-or-slug> --stdin|--file <json>",
		Short:             "Attach an agent session (provider, nativeSessionId, role, repository, worktree, branch, commit, environment)",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", sessionUsage)
			}
			input, err := readJSONInput(stdin, file)
			if err != nil {
				return err
			}
			for _, key := range input.Keys() {
				if !slices.Contains(sessionInputFields, key) {
					return invalid("unsupported session field \"%s\"", key)
				}
			}
			machine, host, err := tracking.LocalMachine()
			if err != nil {
				return err
			}
			t := attachOpts
			key := t.idempotencyKey
			if key == "" {
				if key, err = inputString(input, "idempotencyKey", fmt.Sprintf("must be a non-empty string of at most %d characters", tracking.Limits.Text)); err != nil {
					return exitFor(err)
				}
			}
			evidence := t.evidence
			if evidence == "" {
				if evidence, err = inputString(input, "evidence", fmt.Sprintf("must be a non-empty string of at most %d characters", tracking.Limits.Text)); err != nil {
					return exitFor(err)
				}
			}
			observedAt, err := inputString(input, "observedAt", "must be an ISO timestamp")
			if err != nil {
				return exitFor(err)
			}
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				execution := ordered.New().Set("id", entityID(p.Meta.ID, key))
				if v, ok := input.Get("provider"); ok {
					execution.Set("provider", v)
				}
				native, _ := input.Get("nativeSessionId")
				execution.Set("nativeSessionId", native)
				if v, ok := input.Get("providerNamespace"); ok {
					execution.Set("providerNamespace", v)
				}
				switch v, ok := input.Get("role"); {
				case role != "":
					execution.Set("role", role)
				case ok && v != nil:
					execution.Set("role", v)
				default:
					execution.Set("role", "implementation")
				}
				execution.Set("machine", machine)
				envValue, envPresent := input.Get("environment")
				env, err := environmentFor(envValue, envPresent, host)
				if err != nil {
					return mutation{}, err
				}
				execution.Set("environment", env)
				for _, k := range []string{"repository", "worktree", "branch", "commit"} {
					if v, ok := input.Get(k); ok {
						execution.Set(k, v)
					}
				}
				in := t.event("session.attached", ordered.New().Set("execution", execution))
				in.IdempotencyKey, in.Evidence, in.ObservedAt = key, evidence, observedAt
				return mutation{input: in}, nil
			})
			if err != nil {
				return err
			}
			execution, _ := o.event.Data.Get("execution")
			id := execution.(*ordered.Obj).Str("id")
			return report(c, t, o, ordered.New().Set("executionId", id), "Attached session "+id)
		},
	}
	attach.Flags().BoolVar(&stdin, "stdin", false, "read session details as JSON from stdin")
	attach.Flags().StringVar(&file, "file", "", "read session details as JSON from a file")
	attach.Flags().StringVar(&role, "role", "", "session role: planning, implementation, or review")
	_ = attach.MarkFlagFilename("file", "json")
	_ = attach.RegisterFlagCompletionFunc("role", cobra.FixedCompletions(tracking.ExecutionRoles, cobra.ShellCompDirectiveNoFileComp))
	addTrackingFlags(attach, attachOpts)

	endOpts := &trackingOpts{options: opts}
	end := &cobra.Command{
		Use:               "end <id-or-slug> <execution-id>",
		Short:             "Mark an attached session as ended",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", sessionUsage)
			}
			if len(args) < 2 || args[1] == "" {
				return invalid("execution ID required\n  Usage: plan session end <id-or-slug> <execution-id>")
			}
			t, executionID := endOpts, args[1]
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				proj, err := project(p, false)
				if err != nil {
					return mutation{}, err
				}
				i := slices.IndexFunc(proj.Executions, func(x *tracking.Execution) bool { return x.ID == executionID })
				if i < 0 {
					return mutation{}, tracking.Errorf("ENOTFOUND", "No session %s on plan %s", executionID, p.Meta.ID)
				}
				if proj.Executions[i].EndedAt != "" {
					return mutation{result: ordered.New().Set("executionId", executionID)}, nil
				}
				return mutation{input: t.event("session.ended", ordered.New().Set("executionId", executionID))}, nil
			})
			if err != nil {
				return err
			}
			return report(c, t, o, ordered.New().Set("executionId", executionID), "Ended session "+executionID)
		},
	}
	addTrackingFlags(end, endOpts)

	session.AddCommand(attach, end)
	return session
}

// ---------- plan pr ----------

const prUsage = "Usage: plan pr <attach|detach|refresh> <id-or-slug> ..."

// observation is the PR state read from gh.
type observation struct{ state, headSha, mergeSha string }

func (o observation) data(prID string) *ordered.Obj {
	return ordered.New().Set("prId", prID).Set("state", o.state).SetIf(o.headSha != "", "headSha", o.headSha).SetIf(o.mergeSha != "", "mergeSha", o.mergeSha)
}

// fetchPR reads a PR with gh. External PR data is untrusted: only identity
// and state facts are read from it, and identity must match what was asked
// for.
func fetchPR(rawURL string) (tracking.PR, observation, error) {
	gh := os.Getenv("PLAN_GH")
	if gh == "" {
		gh = "gh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, gh, "pr", "view", rawURL, "--json", "url,state,isDraft,headRefOid,mergeCommit")
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	err := c.Run()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return tracking.PR{}, observation{}, tracking.Errorf("EDEPENDENCY", "gh is required to verify pull requests: %s", err)
	}
	if err != nil {
		return tracking.PR{}, observation{}, tracking.Errorf("EDEPENDENCY", "gh could not read %s: %s", rawURL, strings.TrimSpace(stderr.String()))
	}
	var pr struct {
		URL         any    `json:"url"`
		State       string `json:"state"`
		IsDraft     bool   `json:"isDraft"`
		HeadRefOid  string `json:"headRefOid"`
		MergeCommit *struct {
			Oid string `json:"oid"`
		} `json:"mergeCommit"`
	}
	if json.Unmarshal(stdout.Bytes(), &pr) != nil {
		return tracking.PR{}, observation{}, tracking.Errorf("EDEPENDENCY", "gh returned malformed JSON")
	}
	canonical, err := tracking.ParsePrURL(fmt.Sprint(pr.URL))
	if err != nil {
		return tracking.PR{}, observation{}, err
	}
	asked, err := tracking.ParsePrURL(rawURL)
	if err != nil {
		return tracking.PR{}, observation{}, err
	}
	if canonical.Key() != asked.Key() {
		return tracking.PR{}, observation{}, tracking.Errorf("ETRACKING", "gh resolved %s to a different pull request (%s)", rawURL, canonical.URL)
	}
	obs := observation{headSha: strings.ToLower(pr.HeadRefOid)}
	switch pr.State {
	case "MERGED":
		obs.state = "merged"
	case "CLOSED":
		obs.state = "closed"
	case "OPEN":
		obs.state = "open"
		if pr.IsDraft {
			obs.state = "draft"
		}
	default:
		return tracking.PR{}, observation{}, tracking.Errorf("EDEPENDENCY", "gh reported unknown PR state \"%s\"", pr.State)
	}
	if pr.MergeCommit != nil {
		obs.mergeSha = strings.ToLower(pr.MergeCommit.Oid)
	}
	return canonical, obs, nil
}

// findPR finds an attached PR by ID or URL.
func findPR(p *plans.Plan, reference string) (*tracking.ProjectedPR, error) {
	proj, err := project(p, false)
	if err != nil {
		return nil, err
	}
	key := ""
	if parsed, err := tracking.ParsePrURL(reference); err == nil {
		key = parsed.Key()
	}
	for _, pr := range proj.PRs {
		if pr.ID == reference || (key != "" && pr.Key() == key) {
			return pr, nil
		}
	}
	return nil, tracking.Errorf("ENOTFOUND", "No attached PR %s on plan %s", reference, p.Meta.ID)
}

// observe records a PR observation in its own locked write. Unchanged
// observations are skipped so refreshes do not grow the plan file.
func observe(idOrSlug, prID string, obs observation, t *trackingOpts) (*outcome, error) {
	return mutate(idOrSlug, "", func(p *plans.Plan) (mutation, error) {
		pr, err := findPR(p, prID)
		if err != nil {
			return mutation{}, err
		}
		if cur := pr.Observed; cur != nil && cur.State == obs.state && cur.HeadSha == obs.headSha && cur.MergeSha == obs.mergeSha {
			return mutation{result: ordered.New().Set("prId", prID)}, nil
		}
		return mutation{input: &tracking.EventInput{
			Type: "pr.observed", Data: obs.data(prID), Actor: t.actorName(), Source: "cli",
			ObservedAt: plans.Now(), Evidence: "gh pr view",
		}}, nil
	})
}

func newPrCmd(opts *options) *cobra.Command {
	pr := &cobra.Command{
		Use:   "pr <attach|detach|refresh> <id-or-slug> ...",
		Short: "Attach, detach, or refresh pull requests on a plan",
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) < 2 {
				return invalid("%s", prUsage)
			}
			return invalid("Unknown pr subcommand: %s\n  %s", args[0], prUsage)
		},
	}

	attachOpts := &trackingOpts{options: opts}
	var role string
	attach := &cobra.Command{
		Use:               "attach <id-or-slug> <pr-url> [--role implements|partial|followup|supporting]",
		Short:             "Attach a GitHub pull request, verified with gh",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", prUsage)
			}
			if len(args) < 2 || args[1] == "" {
				return invalid("PR URL required\n  Usage: plan pr attach <id-or-slug> <pr-url> [--role implements|partial|followup|supporting]")
			}
			if role == "" {
				role = "implements"
			}
			if !slices.Contains(tracking.PrRoles, role) {
				return invalid("invalid role \"%s\" (valid: %s)", role, strings.Join(tracking.PrRoles, ", "))
			}
			t := attachOpts
			if _, err := tracking.ParsePrURL(args[1]); err != nil {
				return exitFor(err)
			}
			identity, obs, err := fetchPR(args[1])
			if err != nil {
				return exitFor(err)
			}
			// The PR attach and its first observation are two events, so the
			// observation is appended in a second locked write.
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				proj, err := project(p, false)
				if err != nil {
					return mutation{}, err
				}
				for _, existing := range proj.PRs {
					if existing.Key() == identity.Key() {
						return mutation{result: ordered.New().Set("prId", existing.ID)}, nil
					}
				}
				data := ordered.New().Set("pr", tracking.PrObj(entityID(p.Meta.ID, t.idempotencyKey), identity, role))
				return mutation{input: t.event("pr.attached", data)}, nil
			})
			if err != nil {
				return err
			}
			prID := o.result.Str("prId")
			if o.event != nil {
				attached, _ := o.event.Data.Get("pr")
				prID = attached.(*ordered.Obj).Str("id")
			}
			envelope := o.envelope
			if !o.duplicate {
				observed, err := observe(args[0], prID, obs, t)
				if err != nil {
					return err
				}
				envelope = observed.envelope
			}
			shown := *o
			shown.envelope = envelope
			return report(c, t, &shown, ordered.New().Set("prId", prID).Set("url", identity.URL), "Attached "+identity.URL)
		},
	}
	attach.Flags().StringVar(&role, "role", "", "PR role: implements, partial, followup, or supporting")
	_ = attach.RegisterFlagCompletionFunc("role", cobra.FixedCompletions(tracking.PrRoles, cobra.ShellCompDirectiveNoFileComp))
	addTrackingFlags(attach, attachOpts)

	detachOpts := &trackingOpts{options: opts}
	detach := &cobra.Command{
		Use:               "detach <id-or-slug> <pr-url|pr-id>",
		Short:             "Detach a pull request",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", prUsage)
			}
			if len(args) < 2 || args[1] == "" {
				return invalid("PR URL or ID required\n  Usage: plan pr detach <id-or-slug> <pr-url|pr-id>")
			}
			t, reference := detachOpts, args[1]
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				pr, err := findPR(p, reference)
				if err != nil {
					return mutation{}, err
				}
				in := t.event("pr.detached", ordered.New().Set("prId", pr.ID))
				in.Revokes = pr.AttachedEventID
				return mutation{input: in}, nil
			})
			if err != nil {
				return err
			}
			return report(c, t, o, ordered.New(), "Detached "+reference)
		},
	}
	addTrackingFlags(detach, detachOpts)

	refreshOpts := &trackingOpts{options: opts}
	refresh := &cobra.Command{
		Use:               "refresh <id-or-slug> [pr-url|pr-id]",
		Short:             "Re-read pull request state with gh",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", prUsage)
			}
			t := refreshOpts
			// Fetch outside the write lock: gh calls are slow and must not
			// block other plan writers.
			p, err := resolveContained(args[0])
			if err != nil {
				return err
			}
			var targets []*tracking.ProjectedPR
			if len(args) > 1 && args[1] != "" {
				pr, err := findPR(p, args[1])
				if err != nil {
					return exitFor(err)
				}
				targets = []*tracking.ProjectedPR{pr}
			} else {
				proj, err := project(p, false)
				if err != nil {
					return exitFor(err)
				}
				targets = proj.PRs
			}
			refreshed := []any{}
			o := &outcome{envelope: p.Envelope(), duplicate: true}
			for _, pr := range targets {
				_, obs, err := fetchPR(pr.URL)
				if err != nil {
					return exitFor(err)
				}
				next, err := observe(args[0], pr.ID, obs, t)
				if err != nil {
					return err
				}
				entry := ordered.New().Set("prId", pr.ID).Set("url", pr.URL).Merge(obs.data(pr.ID)).Set("changed", !next.duplicate)
				refreshed = append(refreshed, entry)
				o = &outcome{envelope: next.envelope, duplicate: o.duplicate && next.duplicate}
			}
			plural := "s"
			if len(refreshed) == 1 {
				plural = ""
			}
			return report(c, t, o, ordered.New().Set("prs", refreshed), fmt.Sprintf("Refreshed %d PR%s", len(refreshed), plural))
		},
	}
	addTrackingFlags(refresh, refreshOpts)

	pr.AddCommand(attach, detach, refresh)
	return pr
}

// ---------- plan stage, review, complete, reopen ----------

func stageCandidates(stages []string) cobra.CompletionFunc {
	return func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
		switch len(args) {
		case 0:
			return planCandidates(true), cobra.ShellCompDirectiveNoFileComp
		case 1:
			return stages, cobra.ShellCompDirectiveNoFileComp
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
}

func newStageCmd(opts *options) *cobra.Command {
	t := &trackingOpts{options: opts}
	var reason string
	settable := tracking.PlanStages[:len(tracking.PlanStages)-1]
	c := &cobra.Command{
		Use:               "stage <id-or-slug> <stage> [--reason <text>]",
		Short:             "Move the plan's journey stage (guarded)",
		Long:              "Move the plan's journey stage: " + strings.Join(settable, ", ") + ".\nCompletion goes through plan complete, and a completed plan through plan reopen.",
		ValidArgsFunction: stageCandidates(settable),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("Usage: plan stage <id-or-slug> <%s>", strings.Join(tracking.PlanStages, "|"))
			}
			if len(args) < 2 || !slices.Contains(tracking.PlanStages, args[1]) {
				return invalid("stage required (valid: %s)\n  Usage: plan stage <id-or-slug> <stage> [--reason <text>]", strings.Join(tracking.PlanStages, ", "))
			}
			target := args[1]
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				proj, err := project(p, true)
				if err != nil {
					return mutation{}, err
				}
				changed, err := tracking.AssertStageTransition(proj, target)
				if err != nil || !changed {
					return mutation{result: ordered.New()}, err
				}
				// Submitting pins the exact body revision under review.
				data := ordered.New().Set("stage", target).SetIf(reason != "", "reason", reason)
				if target == "awaiting_plan_review" {
					data.Set("bodyRevision", tracking.BodyRevision(p.Body))
				}
				return mutation{input: t.event("stage", data)}, nil
			})
			if err != nil {
				return err
			}
			return report(c, t, o, ordered.New(), "Stage: "+target)
		},
	}
	c.Flags().StringVar(&reason, "reason", "", "why the stage changed")
	addTrackingFlags(c, t)
	return c
}

const reviewHelp = "  Usage: plan review record <id-or-slug> plan --decision approved|changes_requested\n         plan review record <id-or-slug> pr <pr-url|pr-id> --state <state> --head <sha>"

func newReviewCmd(opts *options) *cobra.Command {
	review := &cobra.Command{
		Use:   "review record <id-or-slug> <plan|pr> ...",
		Short: "Record a plan or PR review",
		RunE: func(c *cobra.Command, args []string) error {
			return invalid("Usage: plan review record <id-or-slug> <plan|pr> ...\n%s", reviewHelp)
		},
	}
	t := &trackingOpts{options: opts}
	var decision, state, head string
	record := &cobra.Command{
		Use:   "record <id-or-slug> plan --decision <decision> | record <id-or-slug> pr <pr-url|pr-id> --state <state> --head <sha>",
		Short: "Record a review of the submitted plan or of a PR head commit",
		ValidArgsFunction: func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			switch len(args) {
			case 0:
				return planCandidates(true), cobra.ShellCompDirectiveNoFileComp
			case 1:
				return []string{"plan\tReview the submitted plan body", "pr\tReview a PR head commit"}, cobra.ShellCompDirectiveNoFileComp
			}
			return nil, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("Usage: plan review record <id-or-slug> <plan|pr> ...\n%s", reviewHelp)
			}
			kind := ""
			if len(args) > 1 {
				kind = args[1]
			}
			switch kind {
			case "plan":
				if !slices.Contains(tracking.PlanReviewDecisions, decision) {
					return invalid("--decision required (valid: %s)", strings.Join(tracking.PlanReviewDecisions, ", "))
				}
				o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
					proj, err := project(p, true)
					if err != nil {
						return mutation{}, err
					}
					if err := tracking.AssertPlanReview(proj); err != nil {
						return mutation{}, err
					}
					return mutation{input: t.event("plan.review", ordered.New().Set("decision", decision).Set("bodyRevision", tracking.BodyRevision(p.Body)))}, nil
				})
				if err != nil {
					return err
				}
				return report(c, t, o, ordered.New(), "Plan review: "+decision)
			case "pr":
				if len(args) < 3 || args[2] == "" {
					return invalid("PR URL or ID required\n  Usage: plan review record <id-or-slug> pr <pr-url|pr-id> --state <state> --head <sha>")
				}
				if !slices.Contains(tracking.PrReviewStates, state) {
					return invalid("--state required (valid: %s)", strings.Join(tracking.PrReviewStates, ", "))
				}
				if head == "" {
					return invalid("--head <sha> required: a review applies to one PR head commit")
				}
				reference := args[2]
				o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
					pr, err := findPR(p, reference)
					if err != nil {
						return mutation{}, err
					}
					return mutation{input: t.event("pr.review", ordered.New().Set("prId", pr.ID).Set("state", state).Set("headSha", strings.ToLower(head)))}, nil
				})
				if err != nil {
					return err
				}
				var prID any
				if o.event != nil {
					prID, _ = o.event.Data.Get("prId")
				}
				return report(c, t, o, ordered.New().Set("prId", prID), "PR review: "+state)
			}
			return invalid("review target must be plan or pr\n%s", reviewHelp)
		},
	}
	record.Flags().StringVar(&decision, "decision", "", "plan review decision: approved or changes_requested")
	record.Flags().StringVar(&state, "state", "", "PR review state")
	record.Flags().StringVar(&head, "head", "", "PR head commit SHA the review applies to")
	_ = record.RegisterFlagCompletionFunc("decision", cobra.FixedCompletions(tracking.PlanReviewDecisions, cobra.ShellCompDirectiveNoFileComp))
	_ = record.RegisterFlagCompletionFunc("state", cobra.FixedCompletions(tracking.PrReviewStates, cobra.ShellCompDirectiveNoFileComp))
	_ = record.RegisterFlagCompletionFunc("head", cobra.NoFileCompletions)
	addTrackingFlags(record, t)
	review.AddCommand(record)
	return review
}

func newCompleteCmd(opts *options) *cobra.Command {
	t := &trackingOpts{options: opts}
	var reason, noPrRationale string
	const usage = "Usage: plan complete <id-or-slug> --reason <text> [--no-pr-rationale <text>]"
	c := &cobra.Command{
		Use:               "complete <id-or-slug> --reason <text> [--no-pr-rationale <text>]",
		Short:             "Complete after plan approval and merged, approved PRs",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", usage)
			}
			if reason == "" {
				return invalid("--reason required\n  %s", usage)
			}
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				proj, err := project(p, true)
				if err != nil {
					return mutation{}, err
				}
				covered, err := tracking.AssertCompletion(proj, noPrRationale)
				if err != nil {
					return mutation{}, err
				}
				ids := make([]any, len(covered))
				for i, id := range covered {
					ids[i] = id
				}
				data := ordered.New().Set("reason", reason).SetIf(noPrRationale != "", "noPrRationale", noPrRationale).Set("coveredPrIds", ids)
				return mutation{input: t.event("completed", data)}, nil
			})
			if err != nil {
				return err
			}
			return report(c, t, o, ordered.New(), "Completed")
		},
	}
	c.Flags().StringVar(&reason, "reason", "", "why the plan is complete")
	c.Flags().StringVar(&noPrRationale, "no-pr-rationale", "", "why a plan without PRs is complete")
	addTrackingFlags(c, t)
	return c
}

func newReopenCmd(opts *options) *cobra.Command {
	t := &trackingOpts{options: opts}
	var stage, reason string
	usage := "Usage: plan reopen <id-or-slug> --stage " + strings.Join(tracking.ReopenStages, "|") + " --reason <text>"
	c := &cobra.Command{
		Use:               "reopen <id-or-slug> --stage in_progress|planning --reason <text>",
		Short:             "Move a completed plan back to work",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("%s", usage)
			}
			if !slices.Contains(tracking.ReopenStages, stage) || reason == "" {
				return invalid("--stage and --reason required\n  %s", usage)
			}
			o, err := mutate(args[0], t.ifRevision, func(p *plans.Plan) (mutation, error) {
				proj, err := project(p, true)
				if err != nil {
					return mutation{}, err
				}
				if err := tracking.AssertReopen(proj, stage); err != nil {
					return mutation{}, err
				}
				return mutation{input: t.event("reopened", ordered.New().Set("stage", stage).Set("reason", reason))}, nil
			})
			if err != nil {
				return err
			}
			return report(c, t, o, ordered.New(), "Reopened: "+stage)
		},
	}
	c.Flags().StringVar(&stage, "stage", "", "stage to reopen into: in_progress or planning")
	c.Flags().StringVar(&reason, "reason", "", "why the plan is reopened")
	_ = c.RegisterFlagCompletionFunc("stage", cobra.FixedCompletions(tracking.ReopenStages, cobra.ShellCompDirectiveNoFileComp))
	addTrackingFlags(c, t)
	return c
}

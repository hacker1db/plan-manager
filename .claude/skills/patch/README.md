# patch

A Claude Code skill that turns verified security findings into candidate
fixes: ranks the queue, routes each finding to the right verification path,
and writes every diff as inert text for human review — it never applies a
patch to your repo. The last leg of the vulnerability cycle: consumes
`/vuln-triage` output (preferred) or any findings file the triage ingest
recognizes, and delegates vuln-harness results to the execution-verified
`vuln-harness patch` ladder. For how it fits the pipeline and how to
review what it produces, see
[the overview](references/overview.md).

## Requirements

- Claude Code CLI installed and authenticated
- A findings input: `TRIAGE.json` (preferred — already verified and
  ranked), `VULN-FINDINGS.json` (unverified; the skill warns), or a
  vuln-harness `results/<target>/<ts>/` directory
- A read-only checkout of the target codebase (`--repo`, default cwd) —
  required for static mode
- For harness input only: the vuln-harness installed and sandboxed, since
  the skill shells out to `bin/vh-sandboxed patch`. The target's `config.yaml`
  needs a `build_command` (the in-container rebuild step after applying a
  diff) and optionally a `test_command` (the regression suite for the
  regress tier). The four shipped targets already have these.

## Usage

```
/patch results/<target>/<ts>/TRIAGE.json --repo ./my-service          # canonical: triaged findings
/patch results/<target>/<ts>/TRIAGE.json --repo ./my-service --top 5  # only the 5 highest-severity
/patch results/<target>/<ts>/ --model <model-id>                      # harness results → verification ladder
/patch findings.json --repo ./src --id f003                           # one finding by id
/patch results/<target>/<ts>/TRIAGE.json --repo ./src --fresh         # ignore checkpoint, start over
```

How the input routes: a harness results directory delegates to the
`vuln-harness patch` CLI, whose ladder rebuilds the target, replays the
PoC, runs the test suite, and re-attacks the patched binary. Static
findings (no PoC to replay) get a fresh-context patch subagent per finding
— root-cause-first, variant hunt, minimal diff, regression test emitted as
part of the diff — plus a separate reviewer agent that sees only
`{file, line, category}` and the diff bytes, never the scanner's prose.
`--model` is passed through to `vuln-harness patch`; in static mode
subagents inherit the session model.

You can also drive the harness CLI directly — same ladder, no skill in
between (it ships with the harness; no extra install):

```bash
# After a find run has produced results/<target>/<ts>/:
bin/vh-sandboxed patch results/<target>/<ts>/ --model <m>

# Or try it standalone on the pre-baked canary fixture (no find run needed):
bin/vh-sandboxed patch targets/canary/fixtures/results_sample --model <m>

bin/vh-sandboxed patch <results_dir> --bug N               # only bug_NN
bin/vh-sandboxed patch <results_dir> --parallel            # run patch agents concurrently
bin/vh-sandboxed patch <results_dir> --no-reattack         # build/reproduce/regress only (faster, weaker)
bin/vh-sandboxed patch <results_dir> --style               # also run advisory style judge
bin/vh-sandboxed patch <results_dir> --max-iterations N    # fix↔grade cap (default 5)
bin/vh-sandboxed patch <results_dir> --max-turns N         # per-iteration agent budget (default 200)
bin/vh-sandboxed patch <results_dir> --engagement-context <file>   # org-specific auth block
```

## Output

Output lands in the scan's run directory: when the findings already live in
a `results/<target>/<timestamp>/` directory it is adopted, otherwise a
fresh one is minted.

- Static mode: `PATCHES/bug_NN/patch.diff` (the candidate fix, never
  applied) and `PATCHES/bug_NN/patch_result.json` (verdict and provenance).
- Execution-verified mode: the ladder also writes its own per-bug artifacts
  in the harness layout, `reports/bug_NN/{patch.diff, patch_result.json}`
  alongside the exploitability report, with transcripts streaming to
  `patch_transcript_itN.jsonl` and `reattack_transcript_itN.jsonl` per
  iteration; the skill copies each diff and verdict into `PATCHES/bug_NN/`
  so both modes land in the same place.
- `PATCHES.md` / `PATCHES.json` — run summary either way, one row per
  finding. The `verified` field in each `patch_result.json` says which path
  produced the diff: `ladder_passed` / `ladder_failed` (executable oracle)
  vs `static_review_only` (agent review).

Example output: [`targets/canary/example_skill_runs/PATCHES/`](../../../targets/canary/example_skill_runs/PATCHES/)

## What it does and doesn't do

- **Does:** rank and filter findings, read the target source, generate
  diffs, review each diff independently, delegate harness input to the
  execution-verified ladder, write summaries.
- **Does not:** apply a diff, write anywhere in `--repo`, run
  `git apply`/`patch`, or execute the target in static mode. There is no
  `--apply` flag by design: the capability isn't present, so it can't be
  prompt-injected into use. Applying the fix is your move, after the
  review pass described in
  [the overview (reviewing patches)](references/overview.md#reviewing-generated-patches).

---

Installation, checkpointing/resume, and support are the same for all
skills in this repo: see [docs/skills/README.md](../../../docs/skills/README.md).

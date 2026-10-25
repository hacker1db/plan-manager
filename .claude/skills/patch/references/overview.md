# Patching: closing the loop

After [triage](../../vuln-triage/references/overview.md), you have a queue of verified, ranked
vulnerabilities that you want to patch. The runbook offers two separate
methods for having Claude Mythos 5 write the fixes. Which one applies depends on the kind of finding you have:

- **[Method 1: Execution-verified patching](#execution-verified)** — the
  `vuln-harness patch` CLI command, a stage of the
  [vuln harness](../vuln_harness/vuln-harness.md). Its input is a crash the harness found:
  a proof-of-concept input (PoC), a reproduction command, and an
  AddressSanitizer (ASAN) trace. Because the bug is reproducible on demand,
  the fix can be *proven*: the patched program is rebuilt, and if the patch is successful the PoC won't replay successfully. Every pass/fail decision is made by a deterministic check — never by a model's judgment.
- **[Method 2: Static patching](#static-patching)** — the `/patch` skill's own flow.
  Its input is a findings file with no runnable PoC: `TRIAGE.json` from the
  interactive skills, a scanner export, a manual review. There is nothing
  to replay, so the fix is checked by an independent reviewer agent instead,
  and the result is explicitly labeled as review-verified — never presented
  as proven.

The `/patch` skill invoked with a vuln-harness results directory delegates to `vuln-harness patch`; invoked with static findings, it runs the static patching flow.
The `verified` field in each `PATCHES/bug_NN/patch_result.json` the skill writes records which method produced the diff: `ladder_passed` / `ladder_failed` (execution-verified) vs `static_review_only` (agent review). The
[skill's README](../README.md) tells you how to use the skill and what outputs to expect.

Both methods write a `patch.diff` plus a `patch_result.json` per bug into the scan's run directory, and neither ever applies a patch to your repository — the output is inert text for a human to review.

> ⚠️ **The execution-verified grader executes target code and applies
> model-generated diffs to it.** The same isolation requirements as the vuln harness's find stage apply; see [sandboxing.md](../securely-running-claude/sandboxing.md). And see [§Reviewing generated patches](#reviewing-generated-patches)
> below before upstreaming anything — verification proves the
> crash is fixed, not that the diff is free of new problems.

<a id="execution-verified"></a>
## Method 1: execution-verified patching (`vuln-harness patch`)

The harness's `patch` stage takes a verified crash from a `vuln-harness
run` results directory and produces a fix that passes a verification
ladder. A grader agent in a fresh container verifies the patch diff, and
only the diff bytes cross between the two containers. Notice that this is the same isolation pattern that the harness puts between its find and grade agents.

### How a patch is produced

**Dedup and order.** The CLI walks `result.json` files under the results dir,
groups by crash signature, and orders them the same way `report` does — so
`bug_NN` here is the same `bug_NN` the report stage wrote.

**Patch agent** (container A, a sandbox microVM, no egress except model
calls through the harness's credential proxy — it runs `claude -p`
in-container, so it sits on `vh-internal` like every other agent). Gets the
source tree, the PoC
at `/tmp/poc.bin`, the reproduction command, and the ASAN trace. Reads source,
writes a fix, rebuilds, self-verifies the PoC stops, then emits a `git diff`
from a baseline commit the harness made when it spun up the container. The
agent's prompt steers toward root-cause fixes and a minimal diff: trace
backward from the crash site to where the bad value originated, fix there,
and grep for sibling call sites with the same pattern.

**Grade** (container B, same isolation and network policy, fresh from the same image). Only the diff bytes cross from A to B. It performs a number of deterministic checks in order ("verification ladder", see full ladder below).

If the deterministic checks pass, it will re-attack the patched code with a fresh find agent. Re-attack needs a container built from the patched code that neither the patch agent nor the grader has touched, so the grader starts a third container from the same image, applies the same diff and rebuilds there, and launches the find-agent in it.

**Iterate.** If any step from the verification ladder fails, it doesn't attempt the other ones, and instead feeds the output back to the patching agent to iterate. The failing step's evidence, like compiler error or test output, is fed back into the next patch-agent iteration's prompt. This cycle is repeated up to `--max-iterations` (default 5). Each iteration overwrites `patch.diff` / `patch_result.json` so the last attempt is what's on
disk.

### The verification ladder

Every step on the ladder is an **executable oracle** that can reject a patch, gating progress to the next step on the ladder. **A patch is only suggested to the user when all steps on the ladder pass: build, reproduce, regress, and re-attack.**

| Tier | Question | Oracle | Field in `patch_result.json` |
|---|---|---|---|
| **Build** | Does the patched tree compile? | `git apply` + `build_command` exit code | `t0_builds` |
| **Reproduce** | Is the original crash gone? | Exit 0 AND no `AddressSanitizer:` in output | `t1_poc_stops` |
| **Regress** | Did it break existing behavior? | `test_command` exit code (skipped if none) | `t2_tests_pass` |
| **Re-attack** | Root cause gone, or just this input? | A fresh 50-turn find-agent attacks the patched binary; ASAN decides | `re_attack_clean` |
| Style | Would a maintainer accept it? | LLM judge 0–10 — **advisory only, never gates** | `t3_style_score` |

Note that **Regress runs the project's existing test suite — it does not write a test for the bug being fixed.** If you want a per-vuln regression test that lives on in CI, you could use the `/patch` skill's [static mode](#static-patching), which adds one to the diff whenever the project has a test directory.

**Why re-attack matters.** A patch that compiles and stops the specific PoC is the easy part - preventing workarounds is harder. Re-attack is the guard against that: a fresh find-agent gets 50 turns against the *patched* binary, scoped to the original crash's code path. Any crash it lands fails the verdict; the agent generates the attack, ASAN decides whether it succeeded.

**Caveat.** If re-attack doesn't find anything, view that as "no bypass found in 50 turns," not "root cause proven fixed." 50 turns should be enough to find bypasses, but it can miss fixes that exist in the wrong layer altogether or fixes whose bypass requires hard-to-construct preconditions. To increase confidence in the fix, raise `REATTACK_MAX_TURNS` in `vuln_harness/patch_grade.py`.

### Re-attacking targets that need a launch script

By default, the re-attack agent drives the target as `./binary <input-file>`.
Some targets can't be run that way: they need a launcher, environment
setup, multi-process orchestration, or take input through something other
than a file. For those, write a launch script and point
`reattack_harness: <path>` at it in the target's `config.yaml`. The agent
then writes its PoCs to `/poc/` and runs your script instead of the binary.

Nothing downstream changes. The agent still emits `<poc_path>`,
`<reproduction_command>`, `<crash_output>`, and `<dup_check>`, so the
grader and dedup work exactly as in the default mode.

The launch script is the one piece you write yourself, and it has a
simple job: run every PoC file under `/poc/` against the instrumented
target and report the outcome through its exit code. Exit 1 means a crash
was found — print the sanitizer trace. Exit 0 means every PoC ran clean.
Exit 2 means the target couldn't launch at all. Give each PoC fresh state
so one input's effects can't mask another's. All the target-specific
plumbing, such as how the program is launched and what setup it needs,
lives inside the script; the agent never sees any of it and only reads
the exit code.

### Customizing for your codebase

This implementation is the C/C++ memory-safety shape: ASAN as the reproduce oracle and `git diff -- '*.c' '*.h'` as the patch format. For other languages and vulnerability classes the *ladder* generalizes: apply, rebuild, reproduce, regress, re-attack. However, the per-tier oracles change. The [`/customize`](../customizing.md) skill walks through porting; the short version is `vuln_harness/patch_grade.py:_t1_passes()` (what counts as "the bug is gone") and `vuln_harness/prompts/patch_prompt.py` (how to ask for the fix) are the two files that encode the domain.

<a id="static-patching"></a>
## Method 2: static patching (the `/patch` skill)

The `vuln-harness patch` flow assumes the harness's own crash artifacts as
input — a PoC file, an ASAN trace, a reproduction command. That contract
doesn't fit findings from elsewhere: a separate scanner, manual review, or
a model-written report without a runnable PoC. It also doesn't fit patching
a class of bugs across many call sites rather than one crash at a time.

The `/patch` skill's static mode handles this case directly:

```bash
> /patch results/my-service/20260603T150000Z/TRIAGE.json --repo ./my-service --top 5
# → results/my-service/20260603T150000Z/PATCHES/bug_NN/{patch.diff, patch_result.json} + PATCHES.md
```

Each finding goes through three stages, all running in parallel across
findings:

1. **Research** — a fresh-context patch agent reads the finding plus the
   codebase and traces the root cause: where the bad value originates and
   which sibling call sites share the same pattern.
2. **Patch** — the same agent writes a minimal diff that fixes the root
   cause, and adds one regression test to the diff. The test is written to
   fail before the fix and pass after, but the skill never runs it — it
   ships inside the diff for the human who applies it.
3. **Review** — a separate reviewer agent judges the diff. It sees only the
   finding's `{file, line, category}` and the diff bytes, never the patch
   agent's reasoning, so a weak fix can't be argued past it. It checks for
   scope creep, suppression instead of a fix, and new attack surface.

The trust-boundary principle is the same as in method 1: the verifier runs
in fresh context the patch author never touched. What static mode lacks is
execution — nothing is built, run, or applied. The skill writes inert
diffs to the run directory's `PATCHES/` for human review, and labels every
result `verified: "static_review_only"` so it cannot be confused with an
execution-verified fix from method 1.

## Reviewing generated patches

This section applies to both methods. Verification — the ladder in one
case, the reviewer agent in the other — proves the finding is addressed.
It does **not** prove the diff introduces no new problems. Build,
reproduce, and regress are correctness checks against the *original*
behavior; re-attack hunts for variants of the *original* bug. None of them
is a semantic review of the diff for new vulnerabilities, logic changes
outside the fix, or anything a maintainer would reject on sight.

Treat `patch.diff` as a strong draft that needs a human read before it goes
anywhere. Things to look for:

- **Scope creep** — changes to files or functions unrelated to the crash path.
- **Suppression instead of fix** — `try/except: pass`, early-return on the
  exact PoC value, disabling the assertion that fired.
- **New attack surface** — added parsing, new size fields trusted from input,
  weakened validation elsewhere to make the fix "work."
- **Correct diagnosis, wrong fix.** The model often identifies exactly which
  module needs to change but proposes a narrow patch that breaks something
  else — fixing the type at the call site instead of the callee, say, or
  hardcoding the PoC's value. Expect to sometimes keep the analysis but
  rewrite the diff.

Sometimes the diff is sound but you can't apply it directly, for example due to the repo's style conventions the model doesn't know about. In `vuln-harness patch`, the optional `--style` flag runs the advisory style judge and writes a 0–10 score into `patch_result.json`; the `/patch` skill's static reviewer always records a style score.

If that doesn't work well, a pattern we have found works well to address this is to have the model emit a precise *prompt* describing the change instead of the diff itself. The prompt should outline what the new control flow should be, which invariant to enforce and where. You then hand this prompt to the agent or developer that works on the target codebase and has all the relevant context. The find-side agent has the security context; the apply-side has the project context. A human reviews the logical change in between.

For complex fixes, give the patch agent an explicit bailout: if the change
touches more than N files, or the agent's own confidence is low, escalate to
a human with the analysis instead of emitting a diff.

The patch agent's prompt reads target-derived data: the ASAN trace, the
exploitability report, and on retry the build/test output. The harness fences
those with per-call random delimiters and instructs the agent to treat them
as data, not instructions — but prompt-level fencing is a mitigation, not a
guarantee. If you're running against third-party code you don't fully trust,
the diff review is where a poisoned target's influence would surface. See
[prompt-injection.md](../securely-running-claude/prompt-injection.md) for the broader threat model.

---

→ Deeper:

- [Example output](../../targets/canary/example_skill_runs/PATCHES/) (generated with Claude Mythos Preview) — a checked-in `PATCHES/` directory from a `/patch` (method 2) run, showing the diffs and `patch_result.json` files you can expect.
- [Skill source](../SKILL.md) — the `/patch` skill's full prompt and flow.
- [vuln-harness.md](../vuln_harness/vuln-harness.md) — the find/grade/report stages that produce the crashes this page patches.
- [customizing.md](../customizing.md) — how to port the verification ladder to another language or vulnerability domain.
- [best-practices.md §Patching](../best-practices.md#patching) — tips that apply to any patching workflow, including asking Claude to fix a bug interactively.
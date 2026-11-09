# threat-model

A Claude Code skill that builds a threat model for a target codebase. Three
modes. **bootstrap** derives the threat model from the target itself:
source tree, git history, public advisories, and an optional past-vulns
file. **interview** discovers the threat model by walking an application
owner through the four-question framework. **bootstrap-then-interview**
chains the two. All modes write `THREAT_MODEL.md` in a shared
schema that `/ccsec-detection` consumes as scoping context. For why to threat-model before scanning and how it fits in the
pipeline, see [the overview](references/overview.md).

## Model selection

The skill has no `model:` frontmatter pin; it runs on whatever model your
session uses (or `--model` if you pass one). On the internal eval both
`claude-opus-4-6` and `claude-mythos-5` clear the bar;
`claude-mythos-5` scored 95–100% across five runs. Reproduce on the
in-repo target with:

```bash
cd eval/threat-model && MODEL=claude-opus-4-6 ./run_eval.sh drlibs 5
```

If you want the skill itself to request a model, add a `model:` line to
`SKILL.md` frontmatter. It overrides the session model (however set,
`/model` or `--model`) only for the turn the skill is invoked in — fine
for `bootstrap`, but the multi-turn `interview` reverts to the session
model on your next reply, so to hold a model across an interview, set it
at the session level instead.

## Usage

### Bootstrap: derive from the target alone

Use when no application owner is available. Point it at a checkout and,
optionally, a list of past vulnerabilities:

```
/threat-model bootstrap targets/drlibs
/threat-model bootstrap targets/drlibs --vulns targets/drlibs/vulns.txt
```

Without `--vulns` the skill mines `git log`, `CHANGELOG`, and GitHub Security
Advisories itself; with it, it ingests your supplied list first.

The skill spawns a parallel research swarm: docs reader, surface mapper,
infra reader, asset finder, git-history miner, and advisory fetcher, plus a
vuln-file parser when `--vulns` is passed. It
synthesizes their returns into the system-context / assets / entry-points
sections, generalizes the collected vulns into threat classes, gap-fills with
STRIDE for surfaces the vuln history didn't cover, and writes
`results/drlibs/<timestamp>/THREAT_MODEL.md`. That's a harness-style run
directory under cwd: repeat runs never clobber earlier output, and the model
survives a wipe-and-reclone of the target. On small targets (<50 source
files) it runs the same briefs sequentially instead of spawning.

### Interview: discover via owner conversation

Use when an application owner is in the session.

```
/threat-model interview targets/alsa
/threat-model interview targets/alsa --design-doc targets/alsa/README.md
```

Without `--design-doc` the interview opens cold by asking the owner to
describe the system; with it, the skill reads the doc first and summarizes it
back for confirmation.

The skill will walk the owner through the four questions, grounding answers
in the code as it goes, and write `results/alsa/<timestamp>/THREAT_MODEL.md`.
The questions: "what are we working on?", "what can go wrong?", "what are we
going to do about it?", and "did we do a good job?"

### Bootstrap then Interview: draft unattended, then refine

Use when an owner is available but their time is limited: bootstrap produces
the draft unattended, then the interview spends owner time only on what the
code couldn't answer.

```
/threat-model bootstrap-then-interview targets/drlibs/
```

The interview will focus on the bootstrap's open questions instead of starting
cold. If the bootstrap already ran in an earlier session, seed the interview
with its output instead of re-running it:

```
/threat-model interview targets/drlibs/ --seed results/drlibs/<timestamp>/THREAT_MODEL.md
```

## Output

`results/<target>/<timestamp>/THREAT_MODEL.md` with eight sections: system context, assets,
entry points & trust boundaries, threats (the table), deprioritized, open
questions, provenance, recommended mitigations. See `schema.md` for the full contract. Example
output: [`targets/canary/example_skill_runs/THREAT_MODEL.md`](../../../targets/canary/example_skill_runs/THREAT_MODEL.md);
a hand-graded reference lives at `eval/threat-model/golden/drlibs_reference.md`.

## Evaluating output

Generate and score:

```bash
cd eval/threat-model && ./run_eval.sh drlibs 5
```

Runs `/threat-model bootstrap` five times in isolated temp copies of
`targets/drlibs` and scores each against `golden/drlibs.yaml`. Generated
files stay under `/tmp/tm_eval_*/results/run_*/`.

Score a saved file without regenerating:

```bash
python eval/threat-model/tm_eval.py path/to/THREAT_MODEL.md \
  --golden eval/threat-model/golden/drlibs.yaml
```

Exit code 0 above the threshold (default 80%), 1 below. To add your own target
golden see `eval/threat-model/README.md`.

## Notes

- The skill is read-only — it does not build, run, or probe the target —
  and is safe to point at any local checkout.
- The output is a starting point for human review, not a substitute for it.

## References

- Shostack, *The Four Question Framework for Threat Modeling* (2024) —
  https://shostack.org/files/papers/The_Four_Question_Framework.pdf
- OWASP Threat Modeling Cheat Sheet —
  https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- This repo's [docs/securely-running-claude/](../../../docs/securely-running-claude/README.md) and
  [docs/prompting.md](../../../docs/prompting.md).

---

Installation, checkpointing/resume, and support are the same for all
skills in this repo: see [docs/skills/README.md](../../../docs/skills/README.md).

# CI/CD operations guide

This guide is for the repository owner. It says what each pipeline piece does, what you must set
up by hand before it works, and what was and was not proven. You should not need to read the code.
The plan and its review record are in [`ci-cd-plan.md`](ci-cd-plan.md).

Nothing in this repository changes live Vercel or GitHub settings, creates secrets, or reads
secret values. Every such step is listed here as an **operator prerequisite** for you to do.

## Assumptions

These were not confirmed by the owner. If one is wrong, the sections marked with it need a change.

| ID | Assumption | Where it matters |
| --- | --- | --- |
| A1 | Vercel **Hobby** plan: no team, no separate automation member, rollback only to the immediately previous production deployment. | Release and rollback |
| A2 | One **personal Vercel token**, stored only in GitHub environments whose deployment branch policy is `main`. | Drift audit, preview smoke, release |
| A3 | **Two Vercel projects** (preview and production) are acceptable. | Drift audit, preview smoke, release |
| A4 | No `hacker1dbai` GitHub identity is available yet, so PRs are opened by `hacker1db`. | Review rules |

## Environment contract

`config/env.contract.json` lists every environment variable by name, with where it is required,
whether it is a secret, the check the production build applies, the minimum Vercel storage type,
an obviously fake CI fixture, and an owner. The production build guard
(`scripts/check-hosted-env.mjs`), the runtime (`src/lib/server/env.ts`), the Vercel name inventory
(`pnpm check:vercel-env`), the CI fixture build, and the client bundle scan all read it.

| Command | What it does |
| --- | --- |
| `pnpm contract:generate` | Rewrites `src/lib/server/env.contract.ts`, `src/env.ts`, `.env.example` and the table in `docs/hosting.md`, always in that order. |
| `pnpm contract:check` | Fails if any of those files is out of date with the contract. |

To add a variable: add it to the contract, run `pnpm contract:generate`, set the real value in
Vercel for every target the contract lists, then merge. The production build fails closed if you
skip the Vercel step.

### Operator prerequisites (contract)

None to merge. Recommended: in both Vercel projects, change every variable whose contract
sensitivity is `secret` to the **Sensitive** storage type for Production and Preview
(Development stays **Encrypted**; Vercel does not offer Sensitive there). To change the type you
must remove and re-add the variable, typing the value at the prompt
(`vercel env add <NAME> production --sensitive`). Do this one variable at a time and redeploy.

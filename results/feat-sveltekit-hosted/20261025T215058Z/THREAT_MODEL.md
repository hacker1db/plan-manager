# Threat Model: plan-manager

## 1. System context

plan-manager is a local-first library for Markdown/MDX plans. Plans are plain
files with YAML frontmatter stored under `PLAN_HOME` (default
`~/notes/SecondBrain/4.Resources/plans`, inside the user's personal Obsidian
vault). Three surfaces share one `src/` tree: a TypeScript CLI (`src/cli`,
`src/lib`) and a feature-parity Go port (`cli/`) with a terminal UI; a
localhost-only dashboard HTTP server implemented twice (`src/server/server.ts`
on Node `http`, `cli/internal/server` on Go `net/http`), bound to `127.0.0.1`
and serving byte-identical browser JS; and an optional private hosted viewer —
a Next.js 16 App Router app (`src/app`, `src/proxy.ts`, `src/hosted`) deployed
on Vercel with Clerk authentication, a Neon Postgres index, and private Vercel
Blob storage for plan content. Roughly 13.5k lines across TypeScript and Go.

The hosted app lives at `https://planmanager.hacker1db.dev` and is intended for
a single owner or a short Clerk allowlist; the CLI pushes plans to it over
authenticated HTTPS, with the local Markdown remaining the source of truth.
There is no in-tree IaC, CI, Docker, or `vercel.json`: deployment is Vercel
Git-integration builds plus environment-variable secrets, and schema is applied
by running `pnpm db:migrate` from a workstation. The branch name
`feat/sveltekit-hosted` is misleading — the app is still Next.js — and this
checkout (`97b8721`) is two commits behind `main`, which notably carries the
Next.js security patch this branch lacks.

## 2. Assets

| asset | description | sensitivity |
|---|---|---|
| owner_authorization_policy | `PLAN_MANAGER_OWNER_CLERK_USER_IDS` (+ legacy singular fallback) and `PLAN_MANAGER_OAUTH_CLIENT_ID` — the only authorization controls for the hosted app | critical |
| clerk_secret_key | `CLERK_SECRET_KEY`; full backend control of the Clerk instance, enough to impersonate an allowlisted owner | critical |
| neon_database_credential | `DATABASE_URL`, a single role shared by runtime, migration, and local dev; full read/write/DDL over all tables | critical |
| blob_read_write_token | `BLOB_READ_WRITE_TOKEN`; store-wide read/overwrite/delete of every plan object, bypassing all app authorization | critical |
| token_pepper | `PLAN_MANAGER_TOKEN_PEPPER`, prepended to every `pm_` secret before scrypt; with DB write access, enough to forge valid tokens | critical |
| local_env_secret_files | `.env.local` / `.env.production.local` / `.temp.values.txt` pulled via `vercel env pull` (0644 in the sibling `main` checkout) | critical |
| developer_workstation | The owner's macOS account: login Keychain, ambient `gh` auth, SSH keys, other repos; the tool shells out to `$EDITOR`, openers, `pandoc`, `gh`, `security` | critical |
| hosted_plan_content | Current and all historical plan Markdown/MDX in private Vercel Blob (`plans/<id>/<revision>.md`) plus the `plan_versions` index; immutable, no purge path | high |
| hosted_db_rows | Neon `plans`, `cli_tokens`, `plan_versions` rows; no owner/tenant column, so every allowlisted owner shares and can change everything | high |
| cli_write_credentials | `pm_` bearer tokens (unbounded expiry) and the Clerk OAuth access/refresh credential; each grants hosted write to every plan | high |
| local_plan_library | Canonical plan files under `PLAN_HOME` + `archive/`; written by both CLIs, the TUI, the local dashboard, AI agents, and any sync client | high |
| surrounding_obsidian_vault | The ancestors of the default `PLAN_HOME` hold unrelated personal notes; the tool must never read or write outside `PLAN_HOME` | high |
| cli_runtime_code_integrity | The `dist/` build, `bin/plan`, the Go binary, and the embedded dashboard; whoever edits them gains persistent code execution as the user | high |
| local_dashboard_capability | The unauthenticated `127.0.0.1:4173` API: read plan bodies and absolute paths, mutate plans, and `open-in-editor` | high |
| service_availability_and_spend | Vercel/Neon/Blob/Clerk quotas; no rate limiting, unbounded version growth, every `?q=` search reads every plan blob | medium |
| audit_trail | No audit log for token mint/revoke, push, or status change; only platform logs and client-asserted frontmatter tracking | low |

## 3. Entry points & trust boundaries

| entry_point | description | trust_boundary | reachable_assets |
|---|---|---|---|
| hosted-api-v1-push | `PUT /api/v1/plans/[id]/versions`: writes the Blob then upserts `plans` and `plan_versions`; bearer is a `pm_` token or a Clerk OAuth token bound to the CLI client | CLI bearer holder on the internet → hosted plan store | hosted_plan_content, hosted_db_rows, blob_read_write_token |
| hosted-api-v1-tokens | `POST /api/v1/tokens` mints a `pm_` token (owner session + same-origin + JSON); `DELETE /api/v1/tokens/[id]` revokes by id | owner browser session → CLI credential issuance | cli_write_credentials, hosted_db_rows |
| hosted-api-v1-read | `GET /api/v1/plans`, `/plans/[id]`, `/plans/[id]/content` (raw markdown) behind `requireOwnerResponse` | internet → owner plan data | hosted_plan_content, hosted_db_rows |
| hosted-api-v1-config | `GET /api/v1`, unauthenticated, returns `clientId` + Clerk issuer, cached 300s | unauthenticated internet → hosted configuration | owner_authorization_policy |
| hosted-dashboard-api-and-status | `GET /api/plans`, `/api/plans/[id]`; `POST /api/plans/[id]/status` (owner session + Origin check, no content-type check) | owner browser session → owner plan data and writes | hosted_plan_content, hosted_db_rows |
| hosted-proxy-owner-gate | `clerkMiddleware` owner allowlist; early-returns with no gate for `/sign-in*`, `/api/v1`, `/api/v1/*` | public internet → hosted Next.js app | owner_authorization_policy, clerk_secret_key |
| hosted-pages | `/`, `/plans`, `/plans/[id]` (server-renders Blob markdown), `/sign-in`; shell injected via `dangerouslySetInnerHTML` | owner browser → server rendering of Blob markdown | hosted_plan_content |
| hosted-markdown-render | Blob markdown rendered server+client: react-markdown `skipHtml`, or whitelisted MDX blocks (parsed, never evaluated) | token-uploaded markdown → owner browser DOM on the hosted origin | hosted_plan_content, developer_workstation |
| hosted-postgres | Neon serverless tagged-template SQL (parameterized), `tags`/`scopes` as jsonb params | hosted app → Neon Postgres | hosted_db_rows, neon_database_credential |
| hosted-deploy-build-env | Vercel Git build runs `prepare` + `build` with production secrets in env; preview deployments per branch; app sets no CSP/X-Frame-Options | pushed branch + npm registry → Vercel build/runtime holding the secrets | clerk_secret_key, neon_database_credential, blob_read_write_token, token_pepper, cli_runtime_code_integrity |
| local-dashboard-mutation-api | `POST` status/tasks/archive/copy-path/open-in-editor on `127.0.0.1`; Host+Origin+CSRF gate; `open-in-editor` spawns `$EDITOR` | any local process → plan files and a subprocess as the owner | local_plan_library, local_dashboard_capability, developer_workstation, surrounding_obsidian_vault |
| local-dashboard-read-api | `GET /_health` (reveals `planHome`), `/_session` (hands out the CSRF token unauthenticated), `/api/plans`, `/api/plans/:id` (absolute `filePath`), SSE | any local process or browser on `127.0.0.1` → plan library on disk | local_plan_library, local_dashboard_capability |
| local-dashboard-html-sink | Markdown → `pandoc --from=markdown-raw_html-raw_attribute` + a regex denylist sanitizer → `innerHTML`; CSP `script-src 'self'` compensates | plan file content on disk → dashboard-origin DOM | local_dashboard_capability |
| cli-keychain-credential | `security(1)` add/find/delete-generic-password; the secret is passed as a `-w <value>` argv (both ports in this checkout), and `--token` accepts it on argv | CLI ↔ macOS Keychain; same-user processes can read argv | cli_write_credentials, developer_workstation |
| cli-oauth-loopback-login | `plan auth login`: `/api/v1` discovery → issuer metadata → `127.0.0.1:<random>/callback` (state compared constant-time, 5-min timeout); refresh posts to the stored tokenEndpoint | browser/local processes → CLI login; site-supplied endpoints trusted | cli_write_credentials |
| cli-push-target | `plan push` sends the bearer plus the full raw plan (frontmatter incl. `source` paths and tracking) to `PLAN_MANAGER_URL` (any bare-https origin; credential not site-bound) | workstation → whatever origin `PLAN_MANAGER_URL` names | cli_write_credentials, hosted_plan_content, local_plan_library |
| shell-completion | The TS bash completion pipes `plan list` ids into `compgen -W` (word-expanded); the Go port uses Cobra `__complete` (not expanded) | plan frontmatter ids → the user's interactive shell | developer_workstation |
| plan-file-frontmatter-parse | `js-yaml` 4.3.0 `load` (TS) / `yaml.v3` (Go) on frontmatter from editors/agents/sync/import; the CLI path accepts any non-empty string as `id` | plan files on disk → CLI and servers | local_plan_library, developer_workstation |
| markdown-input-and-capture | `plan import`/`create`/`update`/`check` and `plan capture` (HTML via `pandoc`, no `--sandbox`, 8MiB/10s) ingest arbitrary local files or stdin | arbitrary local file or stdin (e.g. agent output) → plan home | local_plan_library, developer_workstation |
| db-migrate-from-workstation | `pnpm db:migrate` runs `001_initial.sql` via `node --env-file=.env.local` against the production `DATABASE_URL` | workstation plaintext env file → production Neon (DDL-capable role) | neon_database_credential, hosted_db_rows |
| supply-chain | `pnpm-lock.yaml` (next 16.3.8, js-yaml 4.3.0) + `cli/go.mod` (x/net 0.38.0 indirect); Vercel installs `--frozen-lockfile`; `prepare` lifecycle script | npm/Go module registries → local and hosted runtime | cli_runtime_code_integrity, clerk_secret_key, neon_database_credential, blob_read_write_token |

## 4. Threats

| id | threat | actor | surface | asset | impact | likelihood | status | controls | evidence |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Remote code execution or denial of service against the hosted app via an unpatched Next.js | remote_unauth | hosted-proxy-owner-gate, hosted-deploy-build-env, supply-chain | hosted_plan_content, clerk_secret_key, neon_database_credential | critical | possible | unmitigated | none on this branch; `main` pins 16.4.1 | GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw, CVE-2026-94482 |
| T2 | Full hosted compromise through theft of the master secrets from Vercel env, a preview deployment, or a workstation `.env.local` | insider | hosted-deploy-build-env, hosted-postgres, db-migrate-from-workstation, hosted-api-v1-read | clerk_secret_key, neon_database_credential, blob_read_write_token, token_pepper, local_env_secret_files | critical | possible | partially_mitigated | `.gitignore`/`.vercelignore`; single-tenant; fail-closed 503 when unset | |
| T3 | Secret exfiltration by malicious dependency or lifecycle script executing in the Vercel build with production secrets in scope | supply_chain | supply-chain, hosted-deploy-build-env | clerk_secret_key, neon_database_credential, blob_read_write_token, token_pepper | critical | rare | partially_mitigated | `--frozen-lockfile`; pnpm 10 blocks dependency build scripts by default; integrity hashes | |
| T4 | Theft of the hosted write credential by any same-user process reading the `security(1)` argument list during store/refresh | local_user | cli-keychain-credential | cli_write_credentials, developer_workstation | high | likely | unmitigated | macOS Keychain ACL only | f6b5921 |
| T5 | Arbitrary command execution in the owner's shell when they Tab-complete with a crafted plan id in the library | local_user | shell-completion | developer_workstation | high | possible | unmitigated | none (TS); Go port uses Cobra `__complete` | |
| T6 | Tampering with or overwriting every hosted plan using a long-lived `pm_` token that survives offboarding and has no listing or tenancy | remote_auth | hosted-api-v1-push, hosted-api-v1-tokens, hosted-postgres | hosted_plan_content, hosted_db_rows | high | possible | partially_mitigated | scrypt+timingSafeEqual; revoke-by-id; owner+same-origin mint | 0134cdf, 5c0bca2 |
| T7 | A co-resident local process or second OS account drives the unauthenticated `127.0.0.1` dashboard to read/rewrite plans or spawn `$EDITOR` as the owner | local_user | local-dashboard-mutation-api, local-dashboard-read-api | local_plan_library, local_dashboard_capability, developer_workstation, surrounding_obsidian_vault | high | possible | partially_mitigated | Host allowlist, Origin check, per-process CSRF — but `/_session` hands the token to any origin-less local client | |
| T8 | Theft of the write credential and plan contents by pointing `PLAN_MANAGER_URL` at a hostile origin or via site-supplied/redirected OAuth endpoints | local_user | cli-push-target, cli-oauth-loopback-login, hosted-api-v1-config | cli_write_credentials, hosted_plan_content | high | possible | partially_mitigated | https-only + bare-URL checks; constant-time `state`; PKCE S256 | |
| T9 | Cross-origin abuse of the hosted cookie-authenticated state-change endpoints (token mint, status change) | remote_unauth | hosted-api-v1-tokens, hosted-dashboard-api-and-status | cli_write_credentials, hosted_db_rows | high | rare | partially_mitigated | `isSameOriginRequest` + `isJsonRequest` on token mint; Origin check on status (no content-type) | 5c0bca2 |
| T10 | Hijack of the owner's authenticated session via content injected into a plan, since the hosted app sets no CSP, X-Frame-Options, or frame-ancestors | remote_auth | hosted-markdown-render, hosted-pages | hosted_plan_content, developer_workstation | high | rare | partially_mitigated | react-markdown `skipHtml`; MDX parsed never evaluated; static-literal props; no rehype-raw | |
| T11 | Denial of service of the hosted function or local parser via `js-yaml` CPU-exhaustion on untrusted plan frontmatter | remote_auth | plan-file-frontmatter-parse, hosted-dashboard-api-and-status | service_availability_and_spend, hosted_plan_content | medium | possible | unmitigated | 1 MiB markdown cap; no alias/merge-key cap before parse | CVE-2026-84375, GHSA-5p4m-2wfm-xmqj |
| T12 | Denial of service of the Go CLI/TUI render path via the `golang.org/x/net` HTML parser on untrusted plan content | local_user | supply-chain, markdown-input-and-capture | service_availability_and_spend, local_plan_library | medium | possible | unmitigated | none; `main`/this branch lock x/net 0.38.0 | CVE-2026-25680 |
| T13 | HTML/script injection into the local dashboard DOM through a pandoc raw-attribute or regex-sanitizer bypass | local_user | local-dashboard-html-sink | local_dashboard_capability | medium | rare | partially_mitigated | `-raw_html-raw_attribute`; regex denylist sanitizer; CSP `script-src 'self'`; `X-Frame-Options: DENY` | |
| T14 | Secrets or private data pushed by mistake persist indefinitely because every revision is kept in Blob + `plan_versions` with no purge path | insider | cli-push-target, hosted-api-v1-push | hosted_plan_content, service_availability_and_spend | medium | possible | unmitigated | explicit-push model; private Blob access | |

## 5. Deprioritized

| threat | reason |
|---|---|
| SQL injection in the hosted Postgres layer | All queries use Neon tagged-template parameters; `tags`/`scopes` are passed as jsonb parameters. No string-built SQL. |
| Write or read outside `PLAN_HOME` (path traversal / symlink) | The CLI uses realpath + no-symlink checks before and after write; the servers use lexical containment plus `lstat` regular-file checks; archive containment is verified. Residual very low. |
| Stored XSS via the hosted markdown/MDX renderer | react-markdown runs with `skipHtml`, images reduced to alt text, default `urlTransform`; MDX is parsed, never evaluated, with lowercase tags allowlisted (attributes dropped), block props required to be static literals, and prototype keys filtered; no rehype-raw. Residual tracked only as T10 (missing headers). |
| DNS rebinding against the local dashboard | The Host-header allowlist plus the Origin check block browser-driven rebinding; the residual non-browser-local vector is tracked as T7. |
| Prototype pollution via plan frontmatter | `metadata.ts` strips `__proto__`/`constructor`/`prototype` and caps unknown fields; the static-props evaluator rejects those keys. |
| `plan capture` running pandoc without `--sandbox` | The HTML→gfm reader has no strong local-file-read primitive by default and the artifact is a user-chosen local path; adding `--sandbox` is recommended hardening (see §8) but not a confirmed code defect, so it is not patched here. |
| Repudiation / weak audit trail | Single-owner model with a short allowlist; no multi-user attribution is required today. Logged as a low-sensitivity asset; risk accepted pending multi-tenant use. |

## 6. Open questions

These need an application owner (seed a later `/threat-model interview --seed`):

- **Clerk instance.** Is production really on a Clerk *development* instance (`docs/hosting.md:34`)? Is sign-up disabled and MFA required on owner accounts? How many IDs are on the allowlist, and is the legacy singular `PLAN_MANAGER_OWNER_CLERK_USER_ID` still set anywhere? Is the in-flight WorkOS migration going to replace all of this?
- **Env scoping.** Do Preview and Development deployments reuse the production `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CLERK_SECRET_KEY`, and pepper? Is Deployment Protection / a WAF / rate limiting in front of the app? Is `PLAN_MANAGER_URL` ever pointed at a preview?
- **Neon.** What privileges does the single `DATABASE_URL` role hold (owner/`neon_superuser`)? Is there a least-privilege runtime role distinct from the migration role? Is preview branching (which clones `cli_tokens`) enabled? What is the PITR window?
- **Outstanding credentials.** How many unrevoked, unexpired rows are in `cli_tokens`, and with what expiries? Do legacy `plan-manager:<remote>` Keychain items remain? Was `--token` ever used (leaving tokens in shell history)?
- **Workstation.** Do `main/.env.local` and `.env.production.local` (0644) still hold live, unrotated values? Does the Mac have other local accounts (bears on T4/T7)? Is `PLAN_HOME` synced (Obsidian Sync/iCloud/git) and writable by other devices or agents? What does the installed `com.plan-manager.serve` LaunchAgent run, and with what environment?
- **Blob & retention.** Is the Blob store private and dedicated to this project? Are Neon/Blob backups enabled, and is there any plan-content retention or purge policy (bears on T14)?
- **Risk appetite.** Is DoS of the hosted viewer (T11/T12) acceptable? Is sending `/plans/<id>` paths to Vercel Analytics acceptable?

## 7. Provenance

- mode: bootstrap
- date: 2026-10-25
- target: /Users/hacker1db/Developer/plan-manager/feat-sveltekit-hosted @ 97b8721
- inputs: git-log + CHANGELOG/docs mined; GitHub Security Advisories (GHSA/CVE) looked up for locked dependency versions; no `--vulns` file
- owner: unset

## 8. Recommended mitigations

| mitigation | threat_ids | closes_class | effort |
|---|---|---|---|
| Upgrade and continuously audit pinned dependencies (next → 16.4.1, js-yaml → 4.3.2, x/net → 0.55.0) and add an advisory gate to CI | T1,T11,T12 | partial | S |
| Pass secrets to `security(1)` on stdin (trailing `-w`), never on argv; drop the `--token` argv path in favor of stdin | T4 | yes | S |
| Never expand untrusted plan ids in shell completion — prefix-match candidates literally (or emit the Cobra `__complete` protocol as the Go port does) | T5 | yes | S |
| Bound and attribute `pm_` tokens: enforce a maximum expiry, add `created_by`/`created_at`/`last_used`, a list endpoint, and per-owner tenancy | T6,T9 | partial | M |
| Set hosted security headers (CSP `default-src 'self'`, `X-Frame-Options`/`frame-ancestors 'none'`) in `next.config.ts` or the proxy, matching the local server | T10,T13 | partial | S |
| Authenticate the local dashboard beyond the ambient CSRF token: require an Origin header, and gate `/_session` so an origin-less local client cannot obtain it | T7 | partial | M |
| Harden CLI egress: bind the stored credential to its issuing site, refuse redirects on credential-bearing requests, and cap response size/time (as the Go port already does) | T8 | partial | M |
| Centralize secrets with least privilege: a read/write-scoped Neon runtime role separate from migration, scoped Blob tokens, and a rotate-on-teardown checklist | T2,T3 | partial | L |
| Add a plan-content purge/retention path and pre-push secret scanning | T14 | partial | M |

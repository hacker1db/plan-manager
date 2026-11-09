# Plan Manager for iPhone and iPad

Native SwiftUI app, iOS 17+ (SwiftUI navigation baseline; owner device compatibility remains unverified). Xcode 26+ / Swift 6.2+ and XcodeGen are required. The checked-in shared scheme and project are generated from `project.yml`.

```sh
xcodegen generate --spec ios/PlanManager/project.yml
xcodebuild -project ios/PlanManager/PlanManager.xcodeproj -list
xcodebuild -project ios/PlanManager/PlanManager.xcodeproj -scheme PlanManager -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/PlanManager/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Run these commands only from a dedicated task worktree. To preview without credentials, add `--fixtures` to the scheme launch arguments. Fixtures are labeled and do not contact a hosted service. Select an installed simulator to run tests; the generic destination compiles but cannot execute tests.

For development authentication, set `PLAN_SERVICE_URL` to the approved HTTPS preview origin, `WORKOS_CLIENT_ID` to the shared WorkOS environment's approved native public client, and `WORKOS_REDIRECT_URI` to its registered reverse-domain private-scheme callback. These settings contain no secret. Never use a CLI loopback callback, browser cookie, client secret or CLI credential. Register the owner-approved bundle ID and App ID Prefix as required by the final native flow. `dev.example.PlanManager` is an unsigned build placeholder, not a registered identity. Apple team, device OS, native client and the coordinated WorkOS server migration remain pending. See https://github.com/workos/workos-ios for the pinned 0.9.0 public-client API.

The WorkOS public client handles PKCE exchanges and refresh. Native credentials are stored under a service/client-specific Keychain account with WhenUnlockedThisDeviceOnly protection; refreshed tokens replace prior tokens. Sign-out clears the native Keychain record and memory, without signing out web or CLI clients. Server-side native-session revocation must be aligned with the coordinated migration; local sign-out does not claim remote revocation. The API uses an ephemeral cookie-free URLSession and refuses redirects. The WebView uses an ephemeral store, disables JavaScript, blocks network subresources with CSP, and opens permitted links externally. Unsupported diagrams remain readable source. Library content is held in memory and cleared on sign-out; inactive scenes are covered. These controls need real-device privacy/accessibility validation.

The native status API requires the viewed revision and returns 409 on conflicts. Status changes affect only the hosted copy. Tracked plans are read-only until their lifecycle gates can be represented safely. Refresh and review before retrying. A subsequent canonical `plan push` remains conflict-checked; never force an upload to reconcile implicitly. There is no new pull command.

Verification (before the visual-parity change): unsigned generic iOS simulator build and test build passed with Xcode 27.2 and WorkOS 0.9.0. Two native unit tests passed on iPhone 18 Pro / iOS 27.2: callback state/destination rejection and stale fixture status writes. Repository typecheck and 43 hosted tests pass; the earlier full repository suite and production build also passed before the additive paging/anchor changes. Interactive UI launch was blocked by another session owning the simulator. Real WorkOS authentication, physical device signing, accessibility and distribution remain unverified. The server now uses WorkOS AuthKit after integration with main. Native bearer verification still needs a separately approved public-client configuration and token-class-specific verification; status requests carrying Authorization currently fail closed. Cookie-based web status requests retain exact-origin CSRF checks. Do not treat this integration as proof of native login.

The reader API now includes deterministic heading identities and context fingerprints; ambiguous/deleted anchors do not silently reattach. Library pagination is opt-in for compatibility (`limit=1..100`, `offset>=0`, optional `status`), and the app loads bounded pages. Existing unpaged callers retain their response shape.

## Visual parity with the web dashboard

`src/dashboard/style.css` is the design source of truth. The app bundles that file unchanged and the reader WebView renders the same `hero detail-hero`, `metadata` and `document > markdown-body` markup as `plan.js`, so Markdown, MDX blocks, badges and tables match the web exactly, including its ≤480px rules. Native chrome (library, cards, filters, sign-in) uses `Sources/Theme.swift`, which mirrors the `:root` tokens: linkarzu palette, Iowan Old Style / Avenir Next / Menlo, square edges, hard 7px (4px on phones) offset shadows, the 28px paper grid and the tri-colour topline. If a token changes in `style.css`, update `Theme.swift` to match. The app is dark-only, like the web. Mobile adaptations: the web rail collapses above the hero (as the web does below 900px), status changes move to the navigation bar, touch targets are at least 44pt, and fonts scale with Dynamic Type.

## Environments

The iOS build has no environment of its own. Each build points at one hosted tier, and that tier's WorkOS environment must issue the native token:

| Tier | `PLAN_SERVICE_URL` | WorkOS environment | Native redirect |
| --- | --- | --- | --- |
| Development | Stable HTTPS preview origin (the simulator cannot use the `http://localhost:5173` web callback) | Development (staging) environment | `<bundle-id>://auth/callback` registered on the native public client |
| Production | `https://planmanager.hacker1db.dev` | Production environment | Same scheme, registered separately in production |

Pass values at build time, for example `xcodebuild … PLAN_SERVICE_URL=https://<preview-origin> WORKOS_CLIENT_ID=client_… WORKOS_REDIRECT_URI=<bundle-id>://auth/callback`. These values are not secrets, but never commit real ones. The redirect scheme must contain a dot and be derived from the registered bundle ID.

Not yet working against any tier: the plan read endpoints (`GET /api/v1/plans`, `/render`) accept only AuthKit browser cookies, and bearer tokens are verified only for the CLI client and `plans:write`. Native reads therefore return 401 until the server verifies native public-client access tokens. That is a separate, approved server change.

The visual-parity change was written on Linux without Xcode, and it has not yet been compiled or run on a simulator.

This first slice does not yet implement comments, desktop comment parity or CLI feedback access. No migration or production configuration is changed. Do not distribute as a completed release.

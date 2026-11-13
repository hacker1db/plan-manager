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

Verification: unsigned generic iOS simulator build and test build passed with Xcode 27.2 and WorkOS 0.9.0. Two native unit tests passed on iPhone 18 Pro / iOS 27.2: callback state/destination rejection and stale fixture status writes. Repository typecheck and 43 hosted tests pass; the earlier full repository suite and production build also passed before the additive paging/anchor changes. Interactive UI launch was blocked by another session owning the simulator. Real WorkOS authentication, physical device signing, accessibility and distribution remain unverified. The server now uses WorkOS AuthKit after integration with main. The hosted API now verifies native bearer tokens on the v1 read and status routes once `PLAN_MANAGER_WORKOS_NATIVE_CLIENT_ID` is set on the server: RS256 against the WorkOS JWKS, an exact `user_management/<client>` issuer (so CLI tokens are rejected), `exp`/`sub`, and the owner allowlist. See `docs/hosting.md` → "Native (iOS) app access". Cookie-based web status requests retain exact-origin CSRF checks. Server verification is unit-tested with locally signed tokens; it has not yet been exercised with a real WorkOS-issued native token. Do not treat it as proof of native login.

To run against the hosted service from a phone, remove `--fixtures` from the scheme launch arguments (fixtures never contact the server) and set `WORKOS_CLIENT_ID` and `WORKOS_REDIRECT_URI` in `project.yml`.

The reader API now includes deterministic heading identities and context fingerprints; ambiguous/deleted anchors do not silently reattach. Library pagination is opt-in for compatibility (`limit=1..100`, `offset>=0`, optional `status`), and the app loads bounded pages. Existing unpaged callers retain their response shape.

This first slice does not yet implement comments, desktop comment parity or CLI feedback access. No migration or production configuration is changed. Do not distribute as a completed release.

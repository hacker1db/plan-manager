# Plan Manager for iPhone and iPad

Native SwiftUI app, iOS 17+ (minimum supported by Clerk 1.7.1; owner device compatibility remains unverified). Xcode 26+ / Swift 6.2+ and XcodeGen are required. The checked-in shared scheme and project are generated from `project.yml`.

```sh
xcodegen generate --spec ios/PlanManager/project.yml
xcodebuild -project ios/PlanManager/PlanManager.xcodeproj -list
xcodebuild -project ios/PlanManager/PlanManager.xcodeproj -scheme PlanManager -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/PlanManager/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Run these commands only from a dedicated task worktree. To preview without credentials, add `--fixtures` to the scheme launch arguments. Fixtures are labeled and do not contact a hosted service. Select an installed simulator to run tests; the generic destination compiles but cannot execute tests.

For development authentication, set `PLAN_SERVICE_URL` to the approved HTTPS preview origin and `CLERK_PUBLISHABLE_KEY` to the existing tenant's development publishable key in local Xcode build settings. Neither is a secret. Never place bearer tokens or secret keys in settings/source. Register the owner-approved bundle ID and App ID Prefix with Clerk, enable Native API and configure associated domains following https://clerk.com/docs/ios/getting-started/quickstart. `dev.example.PlanManager` is an unsigned build placeholder, not a registered identity. Apple team, device OS and development tenant access must be confirmed before device installation.

The SDK owns session storage and refresh. The API uses an ephemeral cookie-free URLSession and refuses redirects. The WebView uses an ephemeral store, disables JavaScript, blocks network subresources with CSP, and opens permitted links externally. Unsupported diagrams remain readable source. Library content is held in memory and cleared on sign-out; inactive scenes are covered. These controls need real-device privacy/accessibility validation.

The native status API requires the viewed revision and returns 409 on conflicts. Status changes affect only the hosted copy. Tracked plans are read-only until their lifecycle gates can be represented safely. Refresh and review before retrying. A subsequent canonical `plan push` remains conflict-checked; never force an upload to reconcile implicitly. There is no new pull command.

Initial verification: unsigned generic iOS simulator build passed with Xcode 27.2; repository typecheck, tests and build passed. No simulator devices were available through device discovery. Native tests, real Clerk authentication, physical device signing, accessibility and release distribution remain unverified. Existing Clerk authorized-party validation remains unchanged pending a development token-claims spike; native sessions without the expected azp may be rejected.

This first slice does not yet implement pagination, heading anchors, comments, desktop comment parity or CLI feedback access. No migration or production configuration is changed. Do not distribute as a completed release.

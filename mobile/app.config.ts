import type { ExpoConfig } from "expo/config"
import { readFileSync } from "node:fs"

// Same palette as the web app: read the tokens straight from the web stylesheet at config time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SOURCE, buildTheme } = require("./scripts/sync-web-theme") as { SOURCE: string; buildTheme: (css: string) => { tokens: Record<string, string> } }
const webTokens = buildTheme(readFileSync(SOURCE, "utf8")).tokens

// Nothing configured here is secret: the WorkOS public client uses PKCE without a client secret.
// Set values in mobile/.env.local (see .env.example) or the shell before `expo start` / `expo run:ios`.
const redirectUri = process.env.PLAN_MANAGER_WORKOS_REDIRECT_URI ?? ""
const bundleId = process.env.PLAN_MANAGER_BUNDLE_ID ?? "dev.hacker1db.planmanager"
// The callback scheme must be registered so iOS/Android route the WorkOS redirect back to the app.
const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(redirectUri)?.[1] ?? bundleId

export default (): ExpoConfig => ({
  name: "Plan Manager",
  slug: "plan-manager",
  version: "1.0.0",
  orientation: "default",
  icon: "./assets/icon.png",
  scheme,
  // The web dashboard is dark-only (`color-scheme: dark`); match it, including native alerts and keyboards.
  userInterfaceStyle: "dark",
  backgroundColor: webTokens.paper,
  ios: {
    supportsTablet: true,
    bundleIdentifier: bundleId,
    // Signing team for device builds (the same team the SwiftUI project used).
    appleTeamId: process.env.PLAN_MANAGER_APPLE_TEAM_ID ?? "DYY5WB84FX",
    // iOS 18+ Home Screen appearances. Generated from the web icon by `pnpm generate-icons`.
    icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png", tinted: "./assets/icon-tinted.png" },
  },
  android: {
    package: bundleId,
    adaptiveIcon: {
      backgroundColor: webTokens.ink,
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  plugins: ["expo-router", "expo-web-browser", "expo-secure-store"],
  extra: {
    planServiceUrl: process.env.PLAN_MANAGER_SERVICE_URL ?? "https://planmanager.hacker1db.dev",
    workosClientId: process.env.PLAN_MANAGER_WORKOS_CLIENT_ID ?? "",
    workosRedirectUri: redirectUri,
    fixtures: process.env.PLAN_MANAGER_FIXTURES === "1",
    // GitHub repo whose T3 Code project receives plan comments (the SecondBrain vault).
    t3Repo: process.env.PLAN_MANAGER_T3_REPO ?? "hacker1db/SecondBrain",
  },
})

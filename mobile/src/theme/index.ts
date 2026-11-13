import { Platform } from "react-native"
import type { PlanStatus } from "../lib/shared"
import { webTokens as token } from "./web-theme.generated"

/** Flattens a CSS `rgba(...)` token over an opaque hex base, as the browser does when painting it. */
export function composite(rgba: string, baseHex: string): string {
  const match = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(rgba)
  const base = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(baseHex)
  if (!match || !base) return baseHex
  const alpha = Number(match[4])
  return `#${[1, 2, 3].map(index => Math.round(Number(match[index]) * alpha + parseInt(base[index], 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`
}

/** The web dashboard palette (src/dashboard/style.css :root). Dark only, matching the web app. */
export const colors = {
  paper: token.paper,
  paperDeep: token["paper-deep"],
  ink: token.ink,
  panel: token.panel,
  panelRaised: token["panel-raised"],
  edge: token.edge,
  rule: token.rule,
  text: token.text,
  muted: token.muted,
  faint: token.faint,
  accent: token.accent,
  accentDark: token["accent-dark"],
  signal: token.signal,
  active: token.active,
  completed: token.completed,
  archived: token.archived,
  danger: token.danger,
  tag: token.tag,
  highlight: token["term-purple"],
  /** `--panel` / `--panel-raised` painted on `--paper`, for surfaces that must be opaque. */
  panelSolid: composite(token.panel, token.paper),
  panelRaisedSolid: composite(token["panel-raised"], token.paper),
} as const

/**
 * React Native takes one family name, not a CSS stack. On iOS these are the first installed
 * fonts in the web stacks (--display, --body, --mono); JetBrains Mono is not bundled, so the
 * web's own fallback (Menlo) is used. Android uses its generic families.
 */
export const fonts = Platform.select({
  ios: { display: "Iowan Old Style", body: "Avenir Next", mono: "Menlo" },
  default: { display: "serif", body: "sans-serif", mono: "monospace" },
})

export function statusColor(status: PlanStatus | string): string {
  return status === "active" ? colors.active : status === "completed" ? colors.completed : status === "archived" ? colors.archived : colors.edge
}

/** The web's 480px breakpoint offset shadow: `4px 4px 0 var(--paper-deep)`. */
export const OFFSET = 4

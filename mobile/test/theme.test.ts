import { readFileSync } from "node:fs"
import { composite, statusColor } from "../src/theme"
import { readerDocument } from "../src/components/Reader"
import { readerCss, webTokens } from "../src/theme/web-theme.generated"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SOURCE, TARGET, buildTheme, renderModule } = require("../scripts/sync-web-theme")

jest.mock("react-native-webview", () => ({ WebView: () => null }))

test("generated theme matches the web stylesheet (run `pnpm sync-theme` if this fails)", () => {
  expect(readFileSync(TARGET, "utf8")).toBe(renderModule(buildTheme(readFileSync(SOURCE, "utf8"))))
})

test("tokens resolve var() chains to the web palette", () => {
  expect(webTokens.accent).toBe(webTokens["term-aqua"])
  expect(webTokens.active).toBe(webTokens["term-green"])
  expect(Object.values(webTokens).some(value => value.includes("var("))).toBe(false)
  expect(statusColor("completed")).toBe(webTokens.completed)
  expect(statusColor("unknown")).toBe(webTokens.edge)
})

test("translucent panels flatten over paper exactly as a browser paints them", () => {
  expect(composite("rgba(255, 255, 255, 0.032)", "#11171e")).toBe("#191e25")
  expect(composite("rgba(0, 0, 0, 0)", "#11171e")).toBe("#11171e")
  expect(composite("not a colour", "#11171e")).toBe("#11171e")
})

test("reader CSS carries plan-content rules but not dashboard chrome", () => {
  for (const selector of [".markdown-body h2", ".pm-callout", ".pm-tab-list", ".markdown-body pre", ".mermaid-diagram"]) expect(readerCss).toContain(selector)
  for (const selector of [".card", ".rail", ".hero", ".btn", ".topline"]) expect(readerCss).not.toContain(`${selector}{`)
  expect(readerCss.split("{").length).toBe(readerCss.split("}").length)
  expect(readerCss).not.toMatch(/<\/style/i)
})

test("extractor keeps selector whitespace and rejects malformed CSS", () => {
  const theme = buildTheme(`:root{--paper:#000;--ink:#000;--panel:#000;--edge:#000;--text:#fff;--muted:#888;--faint:#777;--accent:var(--x);--x:#0ff;--active:#0f0;--completed:#00f;--archived:#f80;--danger:#f00;--tag:#f0f;--display:serif;--body:sans;--mono:mono}
    .markdown-body :not(p){color:red}.card{color:blue}@media (max-width: 480px){.pm-a{color:green}.rail{color:x}}`)
  expect(theme.tokens.accent).toBe("#0ff")
  expect(theme.readerCss).toContain(".markdown-body :not(p){color:red}")
  expect(theme.readerCss).toContain("@media (max-width: 480px){.pm-a{color:green}}")
  expect(theme.readerCss).not.toContain(".card")
  expect(() => buildTheme(".a{")).toThrow()
  expect(() => buildTheme(":root{--accent:var(--missing)}")).toThrow("--missing")
})

test("reader wraps plan HTML in the web's markdown-body article under a strict CSP", () => {
  const page = readerDocument("<h1>Plan</h1>")
  expect(page).toContain('<article class="markdown-body"><h1>Plan</h1></article>')
  expect(page).toContain("default-src 'none'")
})

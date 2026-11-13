import { buildT3Prompt, cleanText, t3Links, T3_PROMPT_LIMIT, upsertAnnotation } from "../src/lib/annotations"
import type { BlockTarget } from "../src/lib/annotator"

// Invisible characters are built at runtime so this source file stays plain ASCII.
const BIDI_OVERRIDE = String.fromCharCode(0x202e)
const ZERO_WIDTH = String.fromCharCode(0x200b)
const ISOLATE = String.fromCharCode(0x2066)
const BELL = String.fromCharCode(7)

const risks: BlockTarget = { key: 5, kind: "list item", heading: "Risks", quote: "Data loss" }
const goals: BlockTarget = { key: 2, kind: "paragraph", heading: "Goals", quote: "Ship it." }

test("annotations are one per block, document-ordered, cleaned, and removed when emptied", () => {
  let items = upsertAnnotation([], risks, "  Add a backup step  ")
  items = upsertAnnotation(items, goals, `Ship *what*?${BIDI_OVERRIDE}`)
  expect(items.map(item => [item.key, item.note])).toEqual([[2, "Ship *what*?"], [5, "Add a backup step"]])
  items = upsertAnnotation(items, risks, "Replace: add restore drill")
  expect(items).toHaveLength(2)
  expect(items[1]).toEqual({ key: 5, kind: "list item", heading: "Risks", quote: "Data loss", note: "Replace: add restore drill" })
  expect(upsertAnnotation(items, risks, "   ")).toHaveLength(1)
})

test("text cleaning strips control and bidi characters but keeps newlines in notes", () => {
  expect(cleanText(`a${BELL}b${ZERO_WIDTH}c\r\nd${ISOLATE}`, true)).toBe("abc\nd")
  expect(cleanText("a\nb", false)).toBe("a b")
})

test("prompt quotes each rendered block with its heading and tells the agent to update and push safely", () => {
  const items = [
    ...upsertAnnotation([], risks, "Add a backup step\nand a restore drill"),
    ...upsertAnnotation([], { key: 0, kind: "heading", heading: null, quote: "Disaster plan" }, "Rename to Recovery plan"),
    ...upsertAnnotation([], { key: 1, kind: "paragraph", heading: null, quote: "Intro" }, "Tighten"),
  ].sort((a, b) => a.key - b.key)
  const prompt = buildT3Prompt({ id: "p1", title: "Disaster plan", revision: "x" }, "abcdef0123456789", items)
  expect(prompt).toContain('plan "Disaster plan" (id: p1)')
  expect(prompt).toContain("rendered plan at hosted revision abcdef012345.")
  expect(prompt).toContain("1. On the heading:\n   > Disaster plan\n   Rename to Recovery plan")
  expect(prompt).toContain("2. On the paragraph near the top:\n   > Intro\n   Tighten")
  expect(prompt).toContain('3. On the list item under "Risks":\n   > Data loss\n   Add a backup step\n   and a restore drill')
  expect(prompt).toContain("plan show p1 --json")
  expect(prompt).toContain("plan update p1 --stdin --if-revision")
  expect(prompt).toContain("never force")
  expect(prompt).toContain("plan push p1 --json")
})

test("long quotes are truncated so many comments still fit", () => {
  const items = upsertAnnotation([], { key: 0, kind: "code block", heading: null, quote: "x".repeat(1000) }, "note")
  const prompt = buildT3Prompt({ id: "p1", title: "T", revision: "r" }, "r", items)
  expect(prompt).toContain(`> ${"x".repeat(239)}…`)
  expect(prompt).not.toContain("x".repeat(241))
})

test("T3 links target the app scheme and the hosted chooser with the vault repo", () => {
  const links = t3Links("Fix 3 & 4", "hacker1db/SecondBrain")
  expect(links.app).toBe("t3code://new?prompt=Fix%203%20%26%204&repo=hacker1db%2FSecondBrain")
  expect(links.web).toBe("https://app.t3.codes/new?prompt=Fix%203%20%26%204&repo=hacker1db%2FSecondBrain")
  expect(new URL(links.web).searchParams.get("prompt")).toBe("Fix 3 & 4")
  expect(t3Links("p", "").web).toBe("https://app.t3.codes/new?prompt=p")
  expect(t3Links("p", "not a repo?x=1").web).toBe("https://app.t3.codes/new?prompt=p")
})

test("prompts over T3's 8,000-character limit are refused with a clear message", () => {
  expect(() => t3Links("a".repeat(T3_PROMPT_LIMIT), "o/r")).not.toThrow()
  expect(() => t3Links("a".repeat(T3_PROMPT_LIMIT + 1), "o/r")).toThrow(/8,001-character prompt; T3 accepts 8,000/)
})

import { JSDOM } from "jsdom"
import { ANNOTATOR_SCRIPT, parseAnnotatorMessage, setAnnotationsScript } from "../src/lib/annotator"

// Runs the exact script string the WebView injects, against a rendered plan in jsdom.
const PLAN = `<article class="markdown-body">
  <h1>Disaster plan</h1>
  <p>Intro <strong>text</strong>.</p>
  <h2>Risks</h2>
  <ul><li>Data loss<ul><li>Nested</li></ul></li><li><p>Loose item</p></li></ul>
  <pre><code>restore --all</code></pre>
  <table><tr><td><p>Cell</p></td></tr></table>
  <p></p>
</article>`

let posted: unknown[]
let window: JSDOM["window"]
let document: Document

// A fresh, isolated DOM per test; scripts run only when the test evaluates them.
function load(html = PLAN) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only" })
  window = dom.window
  document = window.document
  posted = []
  ;(window as unknown as Record<string, unknown>).ReactNativeWebView = { postMessage: (data: string) => posted.push(JSON.parse(data)) }
  window.eval(ANNOTATOR_SCRIPT)
  expect(posted).toEqual([{ type: "ready" }])
  posted = []
}

const pluses = () => [...document.querySelectorAll<HTMLElement>(".pm-plus")]
const tap = (element: Element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))

beforeEach(() => load())

test("adds one + per rendered block, skipping empty blocks, table internals and wrapped list items", () => {
  const kinds = pluses().map(plus => plus.getAttribute("aria-label"))
  expect(kinds).toEqual([
    "Comment on this heading", "Comment on this paragraph", "Comment on this heading",
    "Comment on this list item", "Comment on this list item", "Comment on this paragraph",
    "Comment on this code block", "Comment on this table",
  ])
  // Code blocks and tables scroll, so they are wrapped and the + sits on the wrapper.
  expect(document.querySelector("pre")!.parentElement!.classList.contains("pm-annotatable")).toBe(true)
  expect(document.querySelector("table")!.parentElement!.firstElementChild!.className).toBe("pm-plus")
})

test("tapping + posts the block's text without nested lists, with the nearest heading", () => {
  tap(pluses()[3])
  expect(posted).toEqual([{ type: "comment", key: 3, kind: "list item", heading: "Risks", quote: "Data loss" }])
  tap(pluses()[1])
  expect(posted[1]).toEqual({ type: "comment", key: 1, kind: "paragraph", heading: "Disaster plan", quote: "Intro text." })
  tap(pluses()[0])
  expect(posted[2]).toEqual({ type: "comment", key: 0, kind: "heading", heading: null, quote: "Disaster plan" })
})

test("comments render inline as text (never HTML) and re-open for editing", () => {
  window.eval(setAnnotationsScript([{ key: 1, quote: "Intro text.", note: "<img src=x onerror=alert(1)> tighten" }]))
  const note = document.querySelector(".pm-note")!
  expect(note.textContent).toBe("Comment<img src=x onerror=alert(1)> tighten")
  expect(document.querySelector(".pm-note img")).toBeNull()
  expect(pluses()[1].className).toBe("pm-plus is-annotated")
  expect(posted.at(-1)).toEqual({ type: "placement", unplaced: [] })
  tap(note)
  expect(posted.at(-1)).toEqual({ type: "comment", key: 1, kind: "paragraph", heading: "Disaster plan", quote: "Intro text." })
  // List-item comments go inside the item; clearing removes every note.
  window.eval(setAnnotationsScript([{ key: 3, quote: "Data loss", note: "x" }]))
  expect(document.querySelectorAll(".pm-note")).toHaveLength(1)
  expect(document.querySelector("li > .pm-note")).not.toBeNull()
  window.eval(setAnnotationsScript([]))
  expect(document.querySelectorAll(".pm-note")).toHaveLength(0)
})

test("after a plan update, comments re-attach only to a unique identical block and report the rest", () => {
  load(PLAN.replace("<h1>Disaster plan</h1>", "<h1>Disaster plan</h1><p>New paragraph</p>"))
  window.eval(setAnnotationsScript([
    { key: 1, quote: "Intro text.", note: "moved down one block" },
    { key: 2, quote: "Removed text", note: "gone" },
  ]))
  expect(posted.at(-1)).toEqual({ type: "placement", unplaced: [2] })
  const annotated = pluses().findIndex(plus => plus.classList.contains("is-annotated"))
  expect(annotated).toBe(2)
  // Editing the moved comment keeps its original key, so it updates rather than duplicates.
  tap(pluses()[annotated])
  expect(posted.at(-1)).toMatchObject({ type: "comment", key: 1, quote: "Intro text." })
})

test("payloads stay inert inside the injected script", () => {
  const script = setAnnotationsScript([{ key: 0, quote: "</script><script>", note: `a${String.fromCharCode(0x2028)}b` }])
  expect(script).not.toContain("</script>")
  expect(script).not.toContain(String.fromCharCode(0x2028))
  window.eval(script)
  expect(posted.at(-1)).toEqual({ type: "placement", unplaced: [0] })
})

test("messages from the page are validated before the app trusts them", () => {
  expect(parseAnnotatorMessage('{"type":"comment","key":3,"kind":"list item","heading":"Risks","quote":"Data loss"}'))
    .toEqual({ type: "comment", target: { key: 3, kind: "list item", heading: "Risks", quote: "Data loss" } })
  expect(parseAnnotatorMessage('{"type":"placement","unplaced":[2]}')).toEqual({ type: "placement", unplaced: [2] })
  expect(parseAnnotatorMessage('{"type":"ready"}')).toEqual({ type: "ready" })
  for (const bad of [
    "not json", "null", '{"type":"other"}',
    '{"type":"comment","key":-1,"kind":"paragraph","heading":null,"quote":"x"}',
    '{"type":"comment","key":1.5,"kind":"paragraph","heading":null,"quote":"x"}',
    '{"type":"comment","key":1,"kind":"script","heading":null,"quote":"x"}',
    '{"type":"comment","key":1,"kind":"paragraph","heading":7,"quote":"x"}',
    `{"type":"comment","key":1,"kind":"paragraph","heading":null,"quote":"${"x".repeat(2001)}"}`,
    '{"type":"placement","unplaced":["1"]}',
  ]) expect(parseAnnotatorMessage(bad)).toBeNull()
})

test("the script installs once and does nothing on a page without a plan article", () => {
  window.eval(ANNOTATOR_SCRIPT)
  expect(pluses()).toHaveLength(8)
  expect(posted).toEqual([])
  const empty = new JSDOM("<p>no article</p>", { runScripts: "outside-only" }).window
  const messages: string[] = []
  ;(empty as unknown as Record<string, unknown>).ReactNativeWebView = { postMessage: (data: string) => messages.push(data) }
  empty.eval(ANNOTATOR_SCRIPT)
  expect(empty.document.querySelectorAll(".pm-plus")).toHaveLength(0)
  expect(messages).toEqual([])
})

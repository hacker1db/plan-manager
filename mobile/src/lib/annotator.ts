// In-page annotation layer for the rendered plan. The WebView runs ONLY this script: the page's
// CSP (`default-src 'none'`, no script-src) blocks every script in the plan HTML itself, while
// native-injected scripts are exempt from page CSP. The script never inserts HTML: comment text is
// set with textContent, and the page talks to the app only through validated JSON messages.

export const BLOCK_KINDS = ["heading", "paragraph", "list item", "code block", "table"] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

/** A block the user tapped: `key` is its document-order index at that revision. */
export type BlockTarget = { key: number; kind: BlockKind; heading: string | null; quote: string }

export type AnnotatorMessage =
  | { type: "ready" }
  | { type: "comment"; target: BlockTarget }
  | { type: "placement"; unplaced: number[] }

const MAX_TEXT = 2000
const MAX_BLOCKS = 20000

/** Validates a message from the page. Anything malformed is ignored rather than trusted. */
export function parseAnnotatorMessage(data: string): AnnotatorMessage | null {
  let value: unknown
  try { value = JSON.parse(data) } catch { return null }
  if (!value || typeof value !== "object") return null
  const message = value as Record<string, unknown>
  if (message.type === "ready") return { type: "ready" }
  const key = (input: unknown) => Number.isInteger(input) && (input as number) >= 0 && (input as number) < MAX_BLOCKS
  if (message.type === "comment") {
    const { key: index, kind, heading, quote } = message
    if (!key(index) || !BLOCK_KINDS.includes(kind as BlockKind)) return null
    if (heading !== null && (typeof heading !== "string" || heading.length > MAX_TEXT)) return null
    if (typeof quote !== "string" || quote.length > MAX_TEXT) return null
    return { type: "comment", target: { key: index as number, kind: kind as BlockKind, heading: heading as string | null, quote } }
  }
  if (message.type === "placement" && Array.isArray(message.unplaced) && message.unplaced.length <= MAX_BLOCKS && message.unplaced.every(key)) {
    return { type: "placement", unplaced: message.unplaced as number[] }
  }
  return null
}

/** Script call that (re)draws comments in the page. JSON is a valid, inert JS expression. */
export function setAnnotationsScript(items: readonly { key: number; quote: string; note: string }[]): string {
  const payload = JSON.stringify(items.map(({ key, quote, note }) => ({ key, quote, note }))).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  return `window.__pmAnnotator && window.__pmAnnotator.set(${payload}); true;`
}

/** Gutter, + buttons and inline comment blocks, styled with the web theme's CSS variables. */
export const ANNOTATOR_CSS = [
  "body{padding-left:46px!important}",
  ".pm-annotatable{position:relative}",
  ".pm-plus{position:absolute;left:-38px;top:0.05em;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:1px solid var(--edge);background:var(--ink);color:var(--faint);font:400 16px/1 var(--mono);letter-spacing:0;text-transform:none;font-style:normal;cursor:pointer;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}",
  ".pm-plus:active{border-color:var(--accent);color:var(--accent)}",
  ".pm-plus.is-annotated{border-color:var(--accent);color:var(--accent);background:var(--panel-raised)}",
  "li>.pm-plus{left:calc(-38px - 1.4em)}",
  ".pm-note{display:block;margin:0.5em 0 1em;padding:0.55em 0.9em;border:1px solid var(--edge);border-left:3px solid var(--accent);background:var(--panel-raised);font:400 0.92rem/1.5 var(--body);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;cursor:pointer}",
  ".pm-note-label{display:block;margin-bottom:0.2em;font:600 0.62rem/1.4 var(--mono);letter-spacing:0.12em;text-transform:uppercase;color:var(--accent)}",
].join("")

export const ANNOTATOR_SCRIPT = `(function () {
  if (window.__pmAnnotator) return;
  var root = document.querySelector("article.markdown-body");
  if (!root) return;
  function post(message) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  function kindOf(el) {
    var tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "P") return "paragraph";
    if (tag === "LI") return "list item";
    if (tag === "PRE") return "code block";
    return "table";
  }
  function textOf(el) {
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll("ul,ol,.pm-plus,.pm-note");
    for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
    return (copy.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${MAX_TEXT});
  }
  var found = root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,table");
  var blocks = [];
  for (var i = 0; i < found.length; i++) {
    var el = found[i];
    if (el.tagName !== "TABLE" && el.closest("table")) continue;
    if (el.tagName === "P" && el.closest("pre")) continue;
    if (el.tagName === "LI" && el.querySelector(":scope > p, :scope > pre")) continue;
    if (!textOf(el)) continue;
    blocks.push(el);
  }
  var heading = null;
  var entries = [];
  for (var k = 0; k < blocks.length; k++) {
    var block = blocks[k];
    var kind = kindOf(block);
    var text = textOf(block);
    var host = block;
    if (kind === "code block" || kind === "table") {
      // Scrolling boxes clip absolutely positioned children: wrap them so the + sits outside.
      host = document.createElement("div");
      block.parentNode.insertBefore(host, block);
      host.appendChild(block);
    }
    host.className += (host.className ? " " : "") + "pm-annotatable";
    var plus = document.createElement("span");
    plus.className = "pm-plus";
    plus.setAttribute("role", "button");
    plus.setAttribute("aria-label", "Comment on this " + kind);
    plus.textContent = "+";
    host.insertBefore(plus, host.firstChild);
    entries.push({ key: k, kind: kind, heading: kind === "heading" ? null : heading, quote: text, host: host, plus: plus, annotation: null });
    if (kind === "heading") heading = text;
  }
  function open(entry) {
    var target = entry.annotation
      ? { key: entry.annotation.key, kind: entry.kind, heading: entry.heading, quote: entry.annotation.quote }
      : { key: entry.key, kind: entry.kind, heading: entry.heading, quote: entry.quote };
    post({ type: "comment", key: target.key, kind: target.kind, heading: target.heading, quote: target.quote });
  }
  entries.forEach(function (entry) {
    entry.plus.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); open(entry); });
  });
  function clear() {
    var notes = root.querySelectorAll(".pm-note");
    for (var i = 0; i < notes.length; i++) notes[i].parentNode.removeChild(notes[i]);
    entries.forEach(function (entry) { entry.annotation = null; entry.plus.textContent = "+"; entry.plus.className = "pm-plus"; });
  }
  function place(entry, annotation) {
    entry.annotation = annotation;
    entry.plus.textContent = "\\u270E";
    entry.plus.className = "pm-plus is-annotated";
    entry.plus.setAttribute("aria-label", "Edit comment on this " + entry.kind);
    var note = document.createElement("div");
    note.className = "pm-note";
    note.setAttribute("role", "button");
    var label = document.createElement("span");
    label.className = "pm-note-label";
    label.textContent = "Comment";
    note.appendChild(label);
    note.appendChild(document.createTextNode(String(annotation.note)));
    note.addEventListener("click", function (event) { event.preventDefault(); open(entry); });
    if (entry.host.tagName === "LI") entry.host.appendChild(note);
    else entry.host.parentNode.insertBefore(note, entry.host.nextSibling);
  }
  window.__pmAnnotator = {
    set: function (annotations) {
      clear();
      var unplaced = [];
      (annotations || []).forEach(function (annotation) {
        // Same revision: the block at its index still has its text. After an update, re-attach
        // only to a single block with identical text; otherwise report it rather than guess.
        var entry = entries[annotation.key];
        if (!entry || entry.quote !== annotation.quote || entry.annotation) {
          var matches = entries.filter(function (candidate) { return candidate.quote === annotation.quote && !candidate.annotation; });
          entry = matches.length === 1 ? matches[0] : null;
        }
        if (entry) place(entry, annotation); else unplaced.push(annotation.key);
      });
      post({ type: "placement", unplaced: unplaced });
    }
  };
  // Tell the app the page is ready, so it never sends comments before this script has run.
  post({ type: "ready" });
})(); true;`

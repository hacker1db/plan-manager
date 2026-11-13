// Comments on blocks of the rendered plan, packaged as a T3 Code prompt link.
// T3 Code prompt links (docs/user/prompt-links.md in pingdotgg/t3code) open a prefilled draft that
// is never auto-sent: the user reviews it in T3 and presses Send. `repo` selects the most recently
// used T3 project for that GitHub repository (here the SecondBrain vault).

import type { BlockKind, BlockTarget } from "./annotator"

export type Annotation = { key: number; kind: BlockKind; heading: string | null; quote: string; note: string }
export type AnnotationDraft = { planId: string; revision: string; items: Annotation[]; openedInT3At: number | null }

export const T3_PROMPT_LIMIT = 8000
const QUOTE_LIMIT = 240

/** Removes control, zero-width and bidi characters (T3 strips them too, but warns); keeps newlines. */
export function cleanText(value: string, multiline: boolean): string {
  const cleaned = value
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
  return (multiline ? cleaned : cleaned.replace(/\n/g, " ")).trim()
}

/** One comment per rendered block; an empty note removes it. Order follows the document. */
export function upsertAnnotation(items: readonly Annotation[], target: BlockTarget, note: string): Annotation[] {
  const cleaned = cleanText(note, true)
  const rest = items.filter(item => item.key !== target.key)
  if (!cleaned) return rest
  return [...rest, { key: target.key, kind: target.kind, heading: target.heading, quote: target.quote, note: cleaned }].sort((a, b) => a.key - b.key)
}

function quote(text: string): string {
  const single = cleanText(text, false)
  return single.length > QUOTE_LIMIT ? `${single.slice(0, QUOTE_LIMIT - 1)}…` : single
}

export type PromptPlan = { id: string; title: string; revision: string }

export function buildT3Prompt(plan: PromptPlan, revision: string, items: readonly Annotation[]): string {
  const comments = items.map((item, index) => {
    const where = item.kind === "heading" ? "On the heading" : `On the ${item.kind}${item.heading ? ` under "${quote(item.heading)}"` : " near the top"}`
    const note = item.note.split("\n").map(line => `   ${line}`).join("\n")
    return `${index + 1}. ${where}:\n   > ${quote(item.quote)}\n${note}`
  })
  return [
    `Revise my Plan Manager plan "${quote(plan.title)}" (id: ${plan.id}) using the review comments below.`,
    "",
    `I wrote them on my phone while reading the rendered plan at hosted revision ${revision.slice(0, 12)}. Each quote is the rendered text of the block I commented on (Markdown formatting removed); find each spot by its quote and heading.`,
    "",
    "Comments:",
    ...comments,
    "",
    "Steps:",
    `1. Read the current plan: \`plan show ${plan.id} --json\`.`,
    "2. Apply every comment. Keep the frontmatter and anything I didn't comment on unchanged.",
    `3. Save it with \`plan update ${plan.id} --stdin --if-revision <revision from step 1>\`. If the revision check fails, re-read and retry; never force.`,
    `4. Publish the update so my phone sees it: \`plan push ${plan.id} --json\`.`,
    "5. Reply with one line per comment saying what you changed.",
  ].join("\n")
}

export type T3Links = { app: string; web: string }

/** Throws a user-facing RangeError when the prompt exceeds T3's 8,000-character limit. */
export function t3Links(prompt: string, repo: string): T3Links {
  if (prompt.length > T3_PROMPT_LIMIT) {
    throw new RangeError(`These comments make a ${prompt.length.toLocaleString("en-US")}-character prompt; T3 accepts ${T3_PROMPT_LIMIT.toLocaleString("en-US")}. Shorten or remove some, then try again.`)
  }
  const params = [`prompt=${encodeURIComponent(prompt)}`]
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) params.push(`repo=${encodeURIComponent(repo)}`)
  const query = params.join("&")
  return { app: `t3code://new?${query}`, web: `https://app.t3.codes/new?${query}` }
}

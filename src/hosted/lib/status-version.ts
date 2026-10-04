import yaml from "js-yaml"
import { computeRevision } from "@/lib/ids"
import { isPlanStatus, type PlanStatus, type UnknownRecord } from "@/lib/types"

type StatusMetadata = {
  id: string
  title: string
  created: string
  tags: string[]
}

export async function createStatusVersion(
  markdown: string,
  plan: StatusMetadata,
  status: PlanStatus,
  updated: string,
): Promise<{ markdown: string; revision: string }> {
  if (!isPlanStatus(status)) throw new Error("Invalid plan status")
  const end = markdown.startsWith("---") ? markdown.indexOf("\n---", 3) : -1
  let metadata: UnknownRecord = {}
  let body = markdown
  if (end >= 0) {
    try {
      const parsed: unknown = yaml.load(markdown.slice(3, end).trim())
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as UnknownRecord
    } catch {
      metadata = {}
    }
    body = markdown.slice(end + 4).replace(/^\n/, "")
  }
  const frontmatter = yaml.dump({
    ...metadata,
    id: plan.id,
    title: plan.title,
    status,
    created: plan.created,
    updated,
    tags: plan.tags,
  }, { lineWidth: -1 }).trimEnd()
  const nextMarkdown = `---\n${frontmatter}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`
  return { markdown: nextMarkdown, revision: await computeRevision(nextMarkdown) }
}

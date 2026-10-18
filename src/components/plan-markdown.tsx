import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { sourceFormat, stripFrontmatter } from "@/lib/mdx/format"
import { PlanMdx } from "@/lib/mdx/render"

export function markdownBody(markdown: string): string {
  return stripFrontmatter(markdown)
}

export default function PlanMarkdown({ markdown }: { markdown: string }) {
  if (sourceFormat(markdown) === "mdx") return <article className="markdown-body"><PlanMdx source={markdownBody(markdown)} /></article>
  return <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>{markdownBody(markdown)}</ReactMarkdown></article>
}

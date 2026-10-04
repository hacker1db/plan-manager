import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export function markdownBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
}

export default function PlanMarkdown({ markdown }: { markdown: string }) {
  return <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>{markdownBody(markdown)}</ReactMarkdown></article>
}

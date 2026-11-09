// Plan format detection. `format: mdx` in frontmatter is the portable signal
// (it survives `plan push`); the `.mdx` extension is the on-disk convention.

export const PLAN_FORMATS = ['md', 'mdx'] as const
export type PlanFormat = typeof PLAN_FORMATS[number]

export function isPlanFormat(value: unknown): value is PlanFormat {
  return value === 'md' || value === 'mdx'
}

export function extensionFor(format: PlanFormat): '.md' | '.mdx' {
  return format === 'mdx' ? '.mdx' : '.md'
}

export function formatFromPath(filePath: string): PlanFormat {
  return filePath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'md'
}

export function isPlanFilename(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.mdx')
}

export function stripPlanExtension(name: string): string {
  return name.replace(/\.mdx?$/, '')
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export function sourceFormat(source: string): PlanFormat {
  const match = source.match(FRONTMATTER)
  return match && /^format:\s*["']?mdx["']?\s*$/m.test(match[1]) ? 'mdx' : 'md'
}

export function stripFrontmatter(source: string): string {
  return source.replace(FRONTMATTER, '')
}

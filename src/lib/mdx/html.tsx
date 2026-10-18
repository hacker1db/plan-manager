import { renderToStaticMarkup } from 'react-dom/server'
import { PlanMdx } from './render.tsx'

// Server-side entry for the local dashboard and `plan check`, kept apart from
// render.tsx so the hosted client bundle never pulls in react-dom/server.
export function renderMdxToHtml(source: string): string {
  return renderToStaticMarkup(<PlanMdx source={source} />)
}

export function checkMdx(source: string): string[] {
  const problems: string[] = []
  renderToStaticMarkup(<PlanMdx source={source} problems={problems} />)
  return problems
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

// Adapts a generated dashboard body (src/dashboard/*.html) for the hosted app.
export function hostedShell(body: string, revision?: string): string {
  const hosted = body.replace('<div class="rail-foot">', '<div class="rail-foot"><form method="post" action="/sign-out"><button type="submit" class="action">Sign out</button></form>').replaceAll('data-dashboard-environment="local"', 'data-dashboard-environment="hosted"')
  return revision === undefined ? hosted : hosted.replace('<div id="detail">', `<div id="detail" data-revision="${escapeAttribute(revision)}">`)
}

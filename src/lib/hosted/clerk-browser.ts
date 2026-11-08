// Browser loader for Clerk's official framework-independent JavaScript SDK (clerk-js)
// and prebuilt UI, served from the instance's Frontend API exactly as @clerk/nextjs's
// <ClerkProvider> hot-loaded them. Only the publishable key is used here.

export type ClerkBrowserConfig = { publishableKey: string; signInUrl: string | null }

export interface ClerkBrowser {
  load(options?: Record<string, unknown>): Promise<void>
  mountSignIn(node: HTMLDivElement, props?: Record<string, unknown>): void
  unmountSignIn(node: HTMLDivElement): void
}

declare global {
  interface Window {
    Clerk?: ClerkBrowser
    __internal_ClerkUICtor?: unknown
  }
}

const CLERK_JS_MAJOR = "6"
const CLERK_UI_MAJOR = "1"

export function frontendApiFromPublishableKey(publishableKey: string): string {
  const match = /^pk_(test|live)_([A-Za-z0-9_-]+)$/.exec(publishableKey.trim())
  if (!match) throw new Error("Invalid Clerk publishable key")
  const encoded = match[2].replace(/-/g, "+").replace(/_/g, "/")
  const host = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")).replace(/\$$/, "")
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) throw new Error("Invalid Clerk publishable key")
  return host
}

export function clerkScriptUrls(publishableKey: string): { clerkJs: string; ui: string } {
  const host = frontendApiFromPublishableKey(publishableKey)
  return {
    clerkJs: `https://${host}/npm/@clerk/clerk-js@${CLERK_JS_MAJOR}/dist/clerk.browser.js`,
    ui: `https://${host}/npm/@clerk/ui@${CLERK_UI_MAJOR}/dist/ui.browser.js`,
  }
}

function injectScript(src: string, attributes: Record<string, string>, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.async = true
    script.crossOrigin = "anonymous"
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value)
    script.addEventListener("load", () => ready() ? resolve() : reject(new Error(`Clerk script did not initialize: ${src}`)))
    script.addEventListener("error", () => reject(new Error(`Clerk script failed to load: ${src}`)))
    document.head.append(script)
  })
}

let loading: Promise<ClerkBrowser> | null = null

export function loadClerk(config: ClerkBrowserConfig): Promise<ClerkBrowser> {
  loading ??= (async () => {
    const urls = clerkScriptUrls(config.publishableKey)
    await Promise.all([
      injectScript(urls.ui, { "data-clerk-ui-script": "" }, () => Boolean(window.__internal_ClerkUICtor)),
      // With data-clerk-publishable-key the browser bundle creates window.Clerk itself.
      injectScript(urls.clerkJs, { "data-clerk-js-script": "", "data-clerk-publishable-key": config.publishableKey }, () => Boolean(window.Clerk)),
    ])
    const clerk = window.Clerk!
    await clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      ...(config.signInUrl ? { signInUrl: config.signInUrl } : {}),
    })
    return clerk
  })()
  loading.catch(() => { loading = null })
  return loading
}

<script lang="ts">
  import "../app.css"
  import { onMount } from "svelte"
  import { dev } from "$app/environment"
  import { injectAnalytics } from "@vercel/analytics/sveltekit"
  import { loadClerk } from "$lib/hosted/clerk-browser.ts"
  import type { Snippet } from "svelte"
  import type { LayoutData } from "./$types"

  let { data, children }: { data: LayoutData; children: Snippet } = $props()

  onMount(() => {
    injectAnalytics({ mode: dev ? "development" : "production" })
    // Like <ClerkProvider>: clerk-js runs on every page to keep the short-lived
    // Clerk session cookie refreshed for page loads and dashboard API polling.
    if (data.clerk) loadClerk(data.clerk).catch(error => console.error(error))
  })
</script>

{@render children()}

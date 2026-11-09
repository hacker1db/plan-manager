<script lang="ts">
  import "../app.css"
  import { onMount } from "svelte"
  import { dev } from "$app/env"
  import { injectAnalytics } from "@vercel/analytics/sveltekit"
  import type { Snippet } from "svelte"
  import type { LayoutData } from "./$types"

  let { data, children }: { data: LayoutData; children: Snippet } = $props()

  onMount(() => {
    injectAnalytics({ mode: dev ? "development" : "production" })
  })
</script>

{@render children()}

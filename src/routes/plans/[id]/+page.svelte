<script lang="ts">
  import SharedDashboard from "#lib/components/SharedDashboard.svelte"
  import type { PageData } from "./$types"

  let { data }: { data: PageData } = $props()
</script>

<SharedDashboard view={{ kind: "plan", plan: data.plan, markdown: data.markdown, html: data.html }} />

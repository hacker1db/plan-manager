<script lang="ts">
  import { mount, onMount, unmount } from "svelte"
  import { libraryBody, planBody } from "#lib/hosted/generated-dashboard.ts"
  import { hostedShell } from "#lib/hosted/shell.ts"
  import type { DashboardPlan } from "#lib/hosted/types.ts"
  import HostedPlanContent from "./HostedPlanContent.svelte"

  type View =
    | { kind: "library" }
    | { kind: "plan"; plan: DashboardPlan; markdown: string; html: string }

  let { view }: { view: View } = $props()

  // The canonical local dashboard shell (src/dashboard/*.html), unchanged except for the
  // hosted environment marker and the plan revision consumed by /plan.js.
  const shell = $derived(view.kind === "library" ? hostedShell(libraryBody) : hostedShell(planBody, view.plan.revision))

  onMount(() => {
    let content: ReturnType<typeof mount> | undefined
    if (view.kind === "plan") {
      // Same as the Next.js portal: the toolbar and document replace the shell's
      // loading placeholder inside #detail.
      const target = document.querySelector<HTMLElement>("#detail")
      if (target) {
        target.replaceChildren()
        content = mount(HostedPlanContent, { target, props: { plan: view.plan, markdown: view.markdown, html: view.html } })
      }
    }
    // Load the shared dashboard script after the page is interactive (Next's afterInteractive).
    const script = document.createElement("script")
    script.src = view.kind === "library" ? "/app.js" : "/plan.js"
    document.body.append(script)
    return () => {
      if (content) void unmount(content)
      script.remove()
    }
  })
</script>

<svelte:head><title>Plan Manager</title></svelte:head>

{@html shell}

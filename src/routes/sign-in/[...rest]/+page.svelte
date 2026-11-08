<script lang="ts">
  import { onMount } from "svelte"
  import { loadClerk } from "$lib/hosted/clerk-browser.ts"
  import type { PageData } from "./$types"

  let { data }: { data: PageData } = $props()
  let target: HTMLDivElement
  let failure = $state("")

  onMount(() => {
    let mounted = false
    let clerk: Awaited<ReturnType<typeof loadClerk>> | undefined
    if (!data.clerk) {
      failure = "Hosted service is unavailable"
      return
    }
    loadClerk(data.clerk)
      .then(instance => {
        clerk = instance
        // Path routing under /sign-in, as the catch-all Next.js <SignIn /> page used.
        instance.mountSignIn(target, { routing: "path", path: "/sign-in" })
        mounted = true
      })
      .catch(() => { failure = "Sign-in could not load. Refresh to try again." })
    return () => { if (mounted) clerk?.unmountSignIn(target) }
  })
</script>

<svelte:head><title>Sign in · Plan Manager</title></svelte:head>

<main><div bind:this={target}></div>{#if failure}<p role="alert">{failure}</p>{/if}</main>

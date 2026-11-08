<script lang="ts">
  import { onMount } from 'svelte'
  import { dev } from '$app/env'
  import { inject } from '@vercel/analytics'
  import './globals.css'

  let { children } = $props()
  onMount(() => inject({ mode: dev ? 'development' : 'production' }))
</script>

<svelte:head>
  <title>Plan Manager</title>
  <meta name="description" content="Private plan library" />
</svelte:head>

{@render children()}

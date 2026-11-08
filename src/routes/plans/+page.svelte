<script lang="ts">
  let { data } = $props()
</script>

<svelte:head><script src="/app.js" defer></script></svelte:head>
{@html data.shell}

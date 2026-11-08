<script lang="ts">
  let { data } = $props()
</script>

<svelte:head>
  <title>{data.title} · Plan Library</title>
  <script src="/plan.js" defer></script>
</svelte:head>
{@html data.shell}

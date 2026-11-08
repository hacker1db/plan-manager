<script lang="ts">
  let { data } = $props()
</script>

<svelte:head>
  <title>Sign-in failed · Plan Manager</title>
</svelte:head>

<main>
  <h1>Sign-in did not complete</h1>
  <p>WorkOS could not create a Plan Manager session. Start a new sign-in and try again.</p>
  <p><a href="/sign-in">Try sign-in again</a></p>
  <p><small>Reference: {data.code}</small></p>
</main>

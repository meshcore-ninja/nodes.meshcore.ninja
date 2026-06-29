<script>
  import { onMount } from 'svelte';
  import { isMacPlatform } from '$lib/search.js';

  let isMac = $state(true);
  onMount(() => (isMac = isMacPlatform()));
</script>

<span class="font-sans">{#if isMac}⌘K{:else}Ctrl&nbsp;K{/if}</span>

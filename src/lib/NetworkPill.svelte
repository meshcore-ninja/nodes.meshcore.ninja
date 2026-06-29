<script>
  // A compact network chip: flag + resolved name, falling back to the raw id
  // until (or unless) the catalog resolves it.
  import Flag from '$lib/Flag.svelte';

  let { id, catalog = {} } = $props();
  const net = $derived(catalog[id]);
  const label = $derived(net?.name || id);
  const code = $derived(net?.coverage?.countries?.[0] || '');
</script>

<span class="inline-flex items-center gap-1 rounded bg-elev2 px-1.5 py-0.5 text-[10px] leading-none text-dim">
  <Flag {code} class="h-2.5 w-3.5 opacity-60" />
  {label}
</span>

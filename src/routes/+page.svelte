<script>
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { search, meshNetworks } from '$lib/api.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import { TYPE_LABEL, TYPE_OPTIONS, fmtAgo, shortKey, fmtCoords } from '$lib/format.js';

  // Network catalog (id → details), for resolving names + flags in results.
  let catalog = $state({});
  meshNetworks().then((c) => (catalog = c));

  // Seed search state synchronously from the URL (SPA: window is available at
  // init), so a result page is shareable/bookmarkable with no seeding effect.
  const sp0 = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  let q = $state(sp0.get('q') ?? '');
  let types = $state(new Set((sp0.get('types') ?? '').split(',').filter(Boolean).map(Number)));

  let results = $state([]);
  let total = $state(0);
  let capped = $state(false);
  let loading = $state(false);
  let error = $state('');
  let ran = $state(false); // a search has been issued at least once

  let inflight; // AbortController of the current request

  const hasQuery = $derived(q.trim() !== '' || types.size > 0);

  // React to query changes: debounce, sync the URL, and search. This effect only
  // *reads* q/types (never writes them), so it can't loop. A snapshot is captured
  // so the async work doesn't re-read reactive state.
  let debounce;
  $effect(() => {
    const snap = { q: q.trim(), types: [...types] };
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      writeUrl(snap);
      runSearch(snap);
    }, 200);
    return () => clearTimeout(debounce);
  });

  function toggleType(t) {
    const next = new Set(types);
    next.has(t) ? next.delete(t) : next.add(t);
    types = next;
  }

  function writeUrl(snap) {
    const sp = new URLSearchParams();
    if (snap.q) sp.set('q', snap.q);
    if (snap.types.length) sp.set('types', [...snap.types].sort().join(','));
    const qs = sp.toString();
    goto(`${base}/${qs ? `?${qs}` : ''}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  async function runSearch(snap) {
    if (!snap.q && snap.types.length === 0) {
      results = [];
      total = 0;
      capped = false;
      ran = false;
      error = '';
      return;
    }
    inflight?.abort();
    inflight = new AbortController();
    loading = true;
    error = '';
    ran = true;
    try {
      const d = await search({ q: snap.q, types: snap.types, limit: 100 }, inflight.signal);
      results = d.results ?? [];
      total = d.total ?? results.length;
      capped = !!d.capped;
    } catch (e) {
      if (e.name !== 'AbortError') {
        error = 'Search failed. Is the API reachable?';
        results = [];
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>MeshCore Nodes — search the mesh</title>
</svelte:head>

<section
  class="w-full mx-auto max-w-3xl px-4 transition-all"
  class:pt-[18vh]={!hasQuery}
  class:pt-10={hasQuery}
>
  <div class="text-center mb-6" class:mb-3={hasQuery}>
    <a href="{base}/" class="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <span class="text-accent">◇</span> MeshCore Nodes
    </a>
    {#if !hasQuery}
      <p class="text-dim mt-2">
        A searchable directory of MeshCore nodes, built from observed signed adverts.
      </p>
    {/if}
  </div>

  <!-- Dominant search input -->
  <div class="relative">
    <input
      type="search"
      bind:value={q}
      placeholder="Search by name or public key…"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      class="w-full rounded-xl bg-elev border border-edge px-5 py-4 text-lg outline-none
             focus:border-accent focus:ring-2 focus:ring-accent/30 placeholder:text-muted"
    />
    {#if loading}
      <span class="absolute right-4 top-1/2 -translate-y-1/2 text-dim text-sm">…</span>
    {/if}
  </div>

  <!-- Filters -->
  <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
    {#each TYPE_OPTIONS as t}
      <button
        onclick={() => toggleType(t.value)}
        class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors"
        class:border-accent={types.has(t.value)}
        class:text-accent={types.has(t.value)}
        class:border-edge={!types.has(t.value)}
        class:text-dim={!types.has(t.value)}
      >
        <NodeIcon type={t.value} size={14} />
        {t.label}
      </button>
    {/each}
  </div>

  <!-- Results -->
  {#if ran}
    <div class="mt-6">
      {#if error}
        <p class="text-bad text-sm">{error}</p>
      {:else if results.length === 0 && !loading}
        <p class="text-dim text-sm">No nodes match.</p>
      {:else}
        <div class="text-xs text-muted mb-2">
          {total} match{total === 1 ? '' : 'es'}{capped ? ` · showing first ${results.length}` : ''}
        </div>
        <ul class="divide-y divide-edge rounded-xl border border-edge overflow-hidden">
          {#each results as n (n.pubkey)}
            <li>
              <a
                href="{base}/{n.pubkey}"
                class="flex items-center gap-3 px-4 py-3 hover:bg-elev transition-colors"
              >
                <NodeIcon type={n.type} size={20} class="shrink-0 text-dim" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{n.name || '(unnamed)'}</span>
                  <span class="block truncate text-xs text-muted font-mono">{shortKey(n.pubkey)}</span>
                  {#if n.networks?.length}
                    <span class="mt-1 flex flex-wrap gap-1">
                      {#each n.networks as net}
                        <NetworkPill id={net} {catalog} />
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class="hidden sm:block text-xs text-dim text-right whitespace-nowrap">
                  <span class="block capitalize">{TYPE_LABEL[n.type]}</span>
                  {#if n.hasGps}<span class="block">{fmtCoords(n.lat, n.lon)}</span>{/if}
                  <span class="block">{fmtAgo(n.lastAdvertAt)}</span>
                </span>
                <span class="text-muted">→</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

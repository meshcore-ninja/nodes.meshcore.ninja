<script>
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { nodeDetail, nodeAdverts, nodeLinks, nodeNetworkStats, meshNetworks } from '$lib/api.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NodeMap from '$lib/NodeMap.svelte';
  import AddContactQR from '$lib/AddContactQR.svelte';
  import Flag from '$lib/Flag.svelte';
  import { networkFlags, networkUrl } from '$lib/flags.js';
  import { TYPE_LABEL, fmtTime, fmtAgo, fmtCoords, shortKey } from '$lib/format.js';

  const pubkey = $derived($page.params.pubkey);
  const validKey = $derived(/^[0-9a-f]{64}$/i.test(pubkey));

  let node = $state(null);
  let notFound = $state(false);
  let error = $state('');
  let loading = $state(true);

  // Full advert history, paged from the API (newest first).
  let adverts = $state([]);
  let nextBefore = $state(0);
  let hasMore = $state(false);
  let loadingMore = $state(false);

  // Observed neighbours, per-network advert stats, and the network catalog.
  let links = $state([]);
  let linksTotal = $state(0);
  let netStats = $state({}); // networkId -> { adverts, firstAt, lastAt }
  let catalog = $state({});
  let showAllLinks = $state(false); // neighbours list: top 20 until expanded

  let copied = $state(false);
  function copyKey() {
    navigator.clipboard?.writeText(pubkey).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }

  // Load detail + first history page whenever the pubkey changes.
  $effect(() => {
    const pk = pubkey;
    loading = true;
    error = '';
    notFound = false;
    node = null;
    adverts = [];
    nextBefore = 0;
    hasMore = false;
    links = [];
    linksTotal = 0;
    netStats = {};
    showAllLinks = false;

    if (!validKey) {
      notFound = true;
      loading = false;
      return;
    }

    Promise.all([nodeDetail(pk), nodeAdverts(pk, { limit: 50 })])
      .then(([detail, hist]) => {
        if (pk !== pubkey) return; // a newer navigation won
        if (!detail) {
          notFound = true;
          return;
        }
        node = detail;
        adverts = hist.adverts ?? [];
        hasMore = !!hist.hasMore;
        nextBefore = hist.nextBefore ?? 0;
      })
      .catch(() => {
        if (pk === pubkey) error = 'Failed to load this node.';
      })
      .finally(() => {
        if (pk === pubkey) loading = false;
      });

    // Secondary data — never blocks the profile, fails silently.
    nodeLinks(pk, { limit: 200 })
      .then((d) => {
        if (pk !== pubkey) return;
        links = d.links ?? [];
        linksTotal = d.total ?? links.length;
      })
      .catch(() => {});
    nodeNetworkStats(pk)
      .then((d) => {
        if (pk !== pubkey) return;
        netStats = Object.fromEntries((d.networks ?? []).map((s) => [s.networkId, s]));
      })
      .catch(() => {});
    meshNetworks()
      .then((c) => {
        if (pk === pubkey) catalog = c;
      })
      .catch(() => {});
  });

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    loadingMore = true;
    try {
      const hist = await nodeAdverts(pubkey, { limit: 50, before: nextBefore });
      adverts = [...adverts, ...(hist.adverts ?? [])];
      hasMore = !!hist.hasMore;
      nextBefore = hist.nextBefore ?? 0;
    } catch (e) {
      hasMore = false;
    } finally {
      loadingMore = false;
    }
  }

  // Distinct historical values, newest-first, excluding the current one — the
  // "previously known as / seen at / seen as" timelines. Derived from whatever
  // history pages are loaded so far.
  function distinctPrev(pick, current) {
    const seen = new Set();
    const out = [];
    for (const a of adverts) {
      const v = pick(a);
      if (v == null || v === '' || v === current) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  const prevNames = $derived(node ? distinctPrev((a) => a.name, node.name) : []);
  const prevTypes = $derived(
    node ? distinctPrev((a) => TYPE_LABEL[a.type], TYPE_LABEL[node.type]) : []
  );
  const prevLocations = $derived(
    node
      ? distinctPrev(
          (a) => (a.hasGps ? fmtCoords(a.lat, a.lon) : null),
          node.hasGps ? fmtCoords(node.lat, node.lon) : null
        )
      : []
  );

  // "Last heard" spans both signal types: the newest of any advert or any
  // observed link (network activity). "Last advert" is shown separately.
  const lastLinkSeen = $derived(links.reduce((m, l) => Math.max(m, l.lastSeen || 0), 0));
  const lastHeard = $derived(node ? Math.max(node.lastAdvertAt || 0, lastLinkSeen) : 0);

  // Freshness dot: green if heard within the hour, amber within a day, else grey.
  const lastAge = $derived(node ? Math.max(0, Date.now() / 1000 - lastHeard) : Infinity);
  const freshColor = $derived(lastAge < 3600 ? 'bg-ok' : lastAge < 86400 ? 'bg-warn' : 'bg-muted');

  // Each network the node was heard on, enriched from the catalog (flags) and the
  // per-network advert stats (count + last advert). Most-recently-active first.
  const netDetails = $derived(
    (node?.networks ?? [])
      .map((id) => {
        const c = catalog[id] || {};
        const s = netStats[id] || {};
        return {
          id,
          name: c.name || id,
          flags: networkFlags(c),
          adverts: s.adverts || 0,
          lastAt: s.lastAt || 0
        };
      })
      .sort((a, b) => b.lastAt - a.lastAt)
  );

  // First coverage country for a network id, for the advert-history flag column.
  const netFlagCode = (id) => catalog[id]?.coverage?.countries?.[0] || '';
</script>

<svelte:head>
  <title>{node?.name || 'Node'} — MeshCore Nodes</title>
</svelte:head>

<div class="mx-auto max-w-6xl w-full px-4 py-6">
  <a href="{base}/" class="text-sm text-dim hover:text-ink">← Search</a>

  {#if loading}
    <p class="text-dim mt-8">Loading…</p>
  {:else if notFound}
    <div class="mt-8">
      <h1 class="text-xl font-semibold">Node not found</h1>
      <p class="text-dim mt-2 text-sm">
        No node with this public key has been observed yet.
      </p>
      <p class="font-mono text-xs text-muted mt-2 break-all">{pubkey}</p>
    </div>
  {:else if error}
    <p class="text-bad mt-8">{error}</p>
  {:else if node}
    <!-- Top: identity + overview + extras (left), map + add-to-app (top-right) -->
    <div class="mt-4 grid gap-6 lg:grid-cols-3 items-start">
      <!-- Right column: map + add-to-app (top-right; first on mobile) -->
      <aside class="space-y-6 lg:order-2 lg:sticky lg:top-6">
        <section>
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Location</h2>
            {#if node.hasGps}
              <span class="font-mono text-xs text-dim">{fmtCoords(node.lat, node.lon)}</span>
            {/if}
          </div>
          {#key pubkey}
            <NodeMap lat={node.lat} lon={node.lon} hasGps={node.hasGps} {links} />
          {/key}
          {#if node.hasGps}
            <a
              class="mt-2 block text-center text-sm text-accent2 hover:underline"
              href="https://map.meshcore.ninja/?sel={pubkey}"
              rel="noreferrer"
            >
              Open on the full map ↗
            </a>
          {/if}
        </section>

        <AddContactQR {pubkey} name={node.name} type={node.type} />
      </aside>

      <!-- Left column: identity, overview, networks, links, history -->
      <div class="lg:order-1 lg:col-span-2 space-y-6">
        <!-- Identity header -->
        <header class="rounded-2xl border border-edge bg-elev p-5 sm:p-6">
          <div class="flex items-start gap-4">
            <div
              class="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent ring-1 ring-accent/20"
              title={TYPE_LABEL[node.type]}
            >
              <NodeIcon type={node.type} size={32} />
            </div>
            <div class="min-w-0 flex-1">
              <h1 class="text-2xl sm:text-3xl font-semibold truncate">{node.name || '(unnamed)'}</h1>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-sm text-dim">
                <span class="rounded-full border border-edge px-2 py-0.5 capitalize">
                  {TYPE_LABEL[node.type] ?? 'unknown'}
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="h-2 w-2 rounded-full {freshColor}"></span>
                  Last heard {fmtAgo(lastHeard)}
                </span>
              </div>
            </div>
          </div>

          <!-- Public key -->
          <div class="mt-5">
            <div class="text-[10px] uppercase tracking-wide text-muted mb-1">Public key</div>
            <div class="flex items-center gap-2 rounded-lg bg-bg border border-edge px-3 py-2">
              <span class="flex-1 font-mono text-xs sm:text-sm text-dim overflow-x-auto whitespace-nowrap">{pubkey}</span>
              <button onclick={copyKey} class="shrink-0 text-xs text-dim hover:text-ink border border-edge rounded px-2 py-0.5">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </header>

        <!-- Overview -->
        <section>
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Overview</h2>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {#snippet stat(label, value, sub)}
              <div class="rounded-lg bg-elev px-3 py-2.5">
                <div class="text-xs text-muted">{label}</div>
                <div class="text-base font-semibold mt-1 truncate" title={value}>{value}</div>
                {#if sub}<div class="text-xs text-dim mt-0.5">{sub}</div>{/if}
              </div>
            {/snippet}
            {@render stat('First seen', fmtAgo(node.firstAdvertAt), fmtTime(node.firstAdvertAt))}
            {@render stat('Last heard', fmtAgo(lastHeard), 'advert or link')}
            {@render stat('Last advert', fmtAgo(node.lastAdvertAt), fmtTime(node.lastAdvertAt))}
            {@render stat('Adverts', node.advertCount.toLocaleString(), 'observed total')}
            {@render stat('Networks', String((node.networks ?? []).length), 'heard on')}
            {@render stat('Links', linksTotal ? linksTotal.toLocaleString() : '—', 'neighbours')}
          </div>
        </section>

        <!-- Networks (enriched from the catalog) -->
        {#if netDetails.length}
          <section>
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Networks</h2>
            <div class="grid sm:grid-cols-2 gap-3">
              {#each netDetails as n}
                <a
                  href={networkUrl(n.id)}
                  rel="noreferrer"
                  class="group flex items-center gap-2.5 rounded-lg bg-elev px-3 py-2 hover:bg-elev2 transition-colors"
                >
                  {#if n.flags.length}
                    <span class="flex shrink-0 items-center gap-1">
                      {#each n.flags as f (f.code)}<Flag code={f.code} />{/each}
                    </span>
                  {:else}
                    <span class="text-lg leading-none">🌐</span>
                  {/if}
                  <span class="min-w-0 flex-1 font-medium truncate group-hover:text-accent" title={n.name}>
                    {n.name}
                  </span>
                  {#if n.lastAt}
                    <span class="shrink-0 text-xs text-dim whitespace-nowrap" title={fmtTime(n.lastAt)}>
                      {fmtAgo(n.lastAt)} ({n.adverts.toLocaleString()})
                    </span>
                  {/if}
                </a>
              {/each}
            </div>
          </section>
        {/if}

        <!-- Neighbours / observed links (from the API) -->
        {#if links.length}
          <section>
            <div class="flex items-baseline justify-between mb-2">
              <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Neighbors</h2>
              <span class="text-xs text-muted">{linksTotal} link{linksTotal === 1 ? '' : 's'}</span>
            </div>
            <div class="overflow-x-auto rounded-xl border border-edge">
              <table class="w-full text-sm">
                <thead class="bg-elev2 text-muted text-xs">
                  <tr>
                    <th class="text-left font-medium px-3 py-2">Neighbour</th>
                    <th class="text-left font-medium px-3 py-2">Type</th>
                    <th class="text-right font-medium px-3 py-2">Packets</th>
                    <th class="text-left font-medium px-3 py-2">Last heard</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-edge">
                  {#each showAllLinks ? links : links.slice(0, 20) as l}
                    <tr
                      class="cursor-pointer hover:bg-elev"
                      onclick={() => goto(`${base}/${l.neighbor.pubkey}`)}
                    >
                      <td class="px-3 py-2 max-w-[14rem] truncate text-accent2" title={l.neighbor.name}>
                        {l.neighbor.name || shortKey(l.neighbor.pubkey)}
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap">
                        <span class="inline-flex items-center gap-1.5 capitalize">
                          <NodeIcon type={l.neighbor.type} size={14} class="text-dim" />
                          {TYPE_LABEL[l.neighbor.type]}
                        </span>
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap text-right font-mono text-xs">{l.packetCount.toLocaleString()}</td>
                      <td class="px-3 py-2 whitespace-nowrap text-xs text-dim" title={fmtTime(l.lastSeen)}>{fmtAgo(l.lastSeen)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if links.length > 20}
              <button
                onclick={() => (showAllLinks = !showAllLinks)}
                class="mt-3 rounded-md border border-edge px-4 py-2 text-sm text-dim hover:text-ink hover:border-accent"
              >
                {showAllLinks ? 'Show top 20' : `Show all ${links.length}`}
              </button>
            {/if}
          </section>
        {/if}

        <!-- History-derived timelines -->
        {#if prevNames.length || prevTypes.length || prevLocations.length}
          <section>
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Identity history</h2>
            <div class="grid sm:grid-cols-3 gap-3">
              {#snippet prevCard(title, items, mono)}
                <div class="rounded-lg bg-elev px-3 py-2">
                  <div class="text-xs text-muted mb-1">{title}</div>
                  <ul class="space-y-0.5 text-sm" class:font-mono={mono}>
                    {#each items as v}<li class="truncate capitalize" title={v}>{v}</li>{/each}
                  </ul>
                </div>
              {/snippet}
              {#if prevNames.length}{@render prevCard('Previous names', prevNames, false)}{/if}
              {#if prevTypes.length}{@render prevCard('Previous types', prevTypes, false)}{/if}
              {#if prevLocations.length}{@render prevCard('Previous locations', prevLocations, true)}{/if}
            </div>
            <p class="text-xs text-muted mt-2">Derived from the {adverts.length} advert(s) loaded below.</p>
          </section>
        {/if}
      </div>
    </div>

    <!-- Advert history (full width) -->
    <section class="mt-8">
      <div class="flex items-baseline justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Advert history</h2>
        <span class="text-xs text-muted">{adverts.length} loaded{hasMore ? '+' : ''}</span>
      </div>
      <div class="overflow-x-auto rounded-xl border border-edge">
        <table class="w-full text-sm">
          <thead class="bg-elev2 text-muted text-xs">
            <tr>
              <th class="text-left font-medium px-3 py-2">Received</th>
              <th class="text-left font-medium px-3 py-2">Advert time</th>
              <th class="text-left font-medium px-3 py-2">Name</th>
              <th class="text-left font-medium px-3 py-2">Type</th>
              <th class="text-left font-medium px-3 py-2">Location</th>
              <th class="text-left font-medium px-3 py-2">Network</th>
              <th class="text-left font-medium px-3 py-2">Observer</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-edge">
            {#each adverts as a, i (i)}
              <tr class="hover:bg-elev">
                <td class="px-3 py-2 whitespace-nowrap text-xs" title={fmtTime(a.at)}>{fmtAgo(a.at)}</td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">{fmtTime(a.advertTime)}</td>
                <td class="px-3 py-2 max-w-[16rem] truncate" title={a.name}>{a.name || '—'}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <span class="inline-flex items-center gap-1.5 capitalize">
                    <NodeIcon type={a.type} size={14} class="text-dim" />
                    {TYPE_LABEL[a.type]}
                  </span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">{a.hasGps ? fmtCoords(a.lat, a.lon) : '—'}</td>
                <td class="px-3 py-2 whitespace-nowrap text-xs">
                  {#if a.networkId}
                    <span class="inline-flex items-center gap-1.5">
                      <Flag code={netFlagCode(a.networkId)} class="h-3.5 w-5" />
                      {a.networkId}
                    </span>
                  {:else}—{/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-xs text-dim">{a.observerName || '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if hasMore}
        <button
          onclick={loadMore}
          disabled={loadingMore}
          class="mt-3 rounded-md border border-edge px-4 py-2 text-sm text-dim hover:text-ink hover:border-accent disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load older adverts'}
        </button>
      {:else}
        <p class="text-xs text-muted mt-2">End of history · {adverts.length} advert(s).</p>
      {/if}
    </section>
  {/if}
</div>

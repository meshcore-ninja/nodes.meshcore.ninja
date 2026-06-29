<script>
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Dialog } from 'bits-ui';
  import { ChevronRight, X } from '@lucide/svelte';
  import { MeshCoreDecoder, Utils } from '@michaelhart/meshcore-decoder';
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
  let expandedAdvertGroups = $state(new Set());
  let packetDialogOpen = $state(false);
  let selectedAdvert = $state(null);
  let selectedAdvertGroup = $state(null);
  let decodedPacket = $state(null);
  let highlightedPacket = $state('');
  let packetError = $state('');
  let highlightSeq = 0;
  let highlighterPromise;

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

  function shortHash(hash) {
    if (!hash) return '—';
    return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
  }

  function shortObserverId(id) {
    if (!id) return '—';
    return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  }

  function networkName(id) {
    const n = catalog[id];
    return n?.short_name || n?.name || id || '—';
  }

  function analyzerBase(networkId) {
    return catalog[networkId]?.analyzers?.[0]?.url?.replace(/\/+$/, '') || '';
  }

  function analyzerObserverUrl(advert) {
    const base = analyzerBase(advert?.networkId);
    if (!base || !advert?.observerId) return '';
    return `${base}/#/observers/${encodeURIComponent(advert.observerId)}`;
  }

  function analyzerPacketLinks(group) {
    if (!group?.hash) return [];
    const seen = new Set();
    const out = [];
    for (const advert of group.adverts) {
      const networkId = advert.networkId;
      if (!networkId || seen.has(networkId)) continue;
      seen.add(networkId);
      const base = analyzerBase(networkId);
      if (!base) continue;
      out.push({
        networkId,
        name: networkName(networkId),
        url: `${base}/#/packets/${encodeURIComponent(group.hash)}`
      });
    }
    return out;
  }

  function advertGroupKey(advert, index) {
    return advert.hash || `row-${index}-${advert.at || 0}-${advert.networkId || ''}-${advert.observerName || ''}`;
  }

  function observerLabel(group) {
    const count = group.observerCount;
    return `${count} observer${count === 1 ? '' : 's'}`;
  }

  function toggleAdvertGroup(key) {
    const next = new Set(expandedAdvertGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedAdvertGroups = next;
  }

  function openAdvertDetails(advert, group = null) {
    if (!advert) return;
    highlightSeq++;
    selectedAdvert = advert;
    selectedAdvertGroup = group;
    decodedPacket = null;
    highlightedPacket = '';
    packetError = '';
    if (advert.rawHex) {
      try {
        decodedPacket = MeshCoreDecoder.decode(advert.rawHex);
        highlightDecodedPacket(decodedPacket);
      } catch (err) {
        packetError = err?.message || 'Failed to decode packet.';
      }
    }
    packetDialogOpen = true;
  }

  function toggleGroupClick(event, key) {
    event.stopPropagation();
    toggleAdvertGroup(key);
  }

  function highlighter() {
    highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark-default'],
        langs: ['json']
      })
    );
    return highlighterPromise;
  }

  async function highlightDecodedPacket(packet) {
    const seq = ++highlightSeq;
    const json = JSON.stringify(packet, null, 2);
    try {
      const h = await highlighter();
      const html = h.codeToHtml(json, {
        lang: 'json',
        theme: 'github-dark-default'
      });
      if (seq === highlightSeq) highlightedPacket = html;
    } catch {
      if (seq === highlightSeq) highlightedPacket = '';
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

  const advertGroups = $derived.by(() => {
    const groups = [];
    const byHash = new Map();
    for (const [index, advert] of adverts.entries()) {
      const key = advertGroupKey(advert, index);
      let group = advert.hash ? byHash.get(advert.hash) : null;
      if (!group) {
        group = {
          key,
          hash: advert.hash || '',
          first: advert,
          adverts: [],
          observerCount: 0
        };
        groups.push(group);
        if (advert.hash) byHash.set(advert.hash, group);
      }
      group.adverts.push(advert);
      if ((advert.at || 0) > (group.first.at || 0)) group.first = advert;
    }
    for (const group of groups) {
      const observers = new Set(
        group.adverts
          .map((a) => a.observerId || a.observerName || '')
          .filter((observer) => observer !== '')
      );
      group.observerCount = observers.size || group.adverts.length;
    }
    return groups;
  });

  const packetSummary = $derived(
    decodedPacket
      ? [
          ['Message hash', decodedPacket.messageHash],
          ['Route type', Utils.getRouteTypeName(decodedPacket.routeType)],
          ['Payload type', Utils.getPayloadTypeName(decodedPacket.payloadType)],
          ['Payload version', Utils.getPayloadVersionName(decodedPacket.payloadVersion)],
          ['Path length', String(decodedPacket.pathLength ?? 0)],
          ['Valid', decodedPacket.isValid ? 'yes' : 'no']
        ]
      : []
  );

  const advertSummary = $derived(
    selectedAdvert
      ? [
          ['Received', fmtTime(selectedAdvert.at), fmtAgo(selectedAdvert.at)],
          ['Advert time', fmtTime(selectedAdvert.advertTime), 'packet timestamp'],
          ['Name', selectedAdvert.name || '—'],
          ['Type', TYPE_LABEL[selectedAdvert.type] || 'unknown'],
          [
            'Location',
            selectedAdvert.hasGps ? fmtCoords(selectedAdvert.lat, selectedAdvert.lon) : '—'
          ],
          ['Observer', selectedAdvert.observerName || '—'],
          ['Content hash', selectedAdvert.hash || '—']
        ]
      : []
  );

  const selectedPacketLinks = $derived(analyzerPacketLinks(selectedAdvertGroup));
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
              <th class="text-left font-medium px-3 py-2">Content hash</th>
              <th class="text-left font-medium px-3 py-2">Advert time</th>
              <th class="text-left font-medium px-3 py-2">Name</th>
              <th class="text-left font-medium px-3 py-2 w-12">Type</th>
              <th class="text-left font-medium px-3 py-2">Location</th>
              <th class="text-left font-medium px-3 py-2">Network</th>
              <th class="text-left font-medium px-3 py-2">Observer</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-edge">
            {#each advertGroups as group (group.key)}
              {@const a = group.first}
              {@const canExpand = group.adverts.length > 1}
              {@const expanded = canExpand && expandedAdvertGroups.has(group.key)}
              <tr
                class="cursor-pointer hover:bg-elev"
                onclick={() => openAdvertDetails(a, group)}
              >
                <td class="px-3 py-2 whitespace-nowrap text-xs" title={fmtTime(a.at)}>
                  <span class="inline-flex items-center gap-1.5">
                    {#if canExpand}
                      <button
                        class="grid h-[18px] w-[18px] place-items-center rounded text-muted hover:bg-elev2 hover:text-ink"
                        onclick={(event) => toggleGroupClick(event, group.key)}
                        aria-label={expanded ? 'Collapse observations' : 'Expand observations'}
                      >
                        <ChevronRight
                          size={13}
                          class={`transition-transform ${expanded ? 'rotate-90' : ''}`}
                        />
                      </button>
                    {:else}
                      <span class="w-[18px]"></span>
                    {/if}
                    {fmtAgo(a.at)}
                  </span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">
                  {#if group.hash}
                    <span class="text-accent2" title={group.hash}>{shortHash(group.hash)}</span>
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">{fmtTime(a.advertTime)}</td>
                <td class="px-3 py-2 max-w-[16rem] truncate" title={a.name}>{a.name || '—'}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <span title={TYPE_LABEL[a.type]} aria-label={TYPE_LABEL[a.type]}>
                    <NodeIcon type={a.type} size={15} class="text-dim" />
                  </span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">{a.hasGps ? fmtCoords(a.lat, a.lon) : '—'}</td>
                <td class="px-3 py-2 whitespace-nowrap text-xs">
                  {#if a.networkId}
                    <a
                      class="inline-flex items-center gap-1.5 text-accent2 hover:underline"
                      href={networkUrl(a.networkId)}
                      onclick={(event) => event.stopPropagation()}
                      rel="noreferrer"
                    >
                      <Flag code={netFlagCode(a.networkId)} class="h-3.5 w-5" />
                      {networkName(a.networkId)}
                    </a>
                  {:else}—{/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-xs text-dim">{observerLabel(group)}</td>
              </tr>
              {#if canExpand && expanded}
                {#each group.adverts as detail, detailIndex (`${group.key}-${detailIndex}`)}
                  <tr
                    class="cursor-pointer bg-elev/40 hover:bg-elev"
                    onclick={() => openAdvertDetails(detail, group)}
                  >
                    <td class="px-3 py-2 whitespace-nowrap text-xs text-dim" title={fmtTime(detail.at)}>
                      <span class="pl-5">{fmtAgo(detail.at)}</span>
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted">
                      {group.hash ? shortHash(group.hash) : '—'}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-dim">{fmtTime(detail.advertTime)}</td>
                    <td class="px-3 py-2 max-w-[16rem] truncate text-dim" title={detail.name}>{detail.name || '—'}</td>
                    <td class="px-3 py-2 whitespace-nowrap">
                      <span title={TYPE_LABEL[detail.type]} aria-label={TYPE_LABEL[detail.type]}>
                        <NodeIcon type={detail.type} size={14} class="text-muted" />
                      </span>
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-dim">
                      {detail.hasGps ? fmtCoords(detail.lat, detail.lon) : '—'}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap text-xs text-dim">
                      {#if detail.networkId}
                        <a
                          class="inline-flex items-center gap-1.5 text-accent2 hover:underline"
                          href={networkUrl(detail.networkId)}
                          onclick={(event) => event.stopPropagation()}
                          rel="noreferrer"
                        >
                          <Flag code={netFlagCode(detail.networkId)} class="h-3.5 w-5" />
                          {networkName(detail.networkId)}
                        </a>
                      {:else}—{/if}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap text-xs text-dim">
                      <div>{detail.observerName || '—'}</div>
                      {#if detail.observerId}
                        {@const observerUrl = analyzerObserverUrl(detail)}
                        {#if observerUrl}
                          <a
                            class="font-mono text-[11px] text-accent2 hover:underline"
                            href={observerUrl}
                            onclick={(event) => event.stopPropagation()}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortObserverId(detail.observerId)}
                          </a>
                        {:else}
                          <div class="font-mono text-[11px] text-muted">{shortObserverId(detail.observerId)}</div>
                        {/if}
                      {/if}
                    </td>
                  </tr>
                {/each}
              {/if}
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

    <Dialog.Root bind:open={packetDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          class="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(52rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-edge bg-bg shadow-2xl"
        >
          <div class="flex items-start justify-between gap-4 border-b border-edge px-4 py-3">
            <div class="min-w-0">
              <Dialog.Title class="text-base font-semibold">Advert details</Dialog.Title>
              <Dialog.Description class="mt-1 text-xs text-muted truncate">
                {selectedAdvert?.name || '(unnamed)'} · {selectedAdvert?.hash ? shortHash(selectedAdvert.hash) : 'no content hash'}
              </Dialog.Description>
            </div>
            <Dialog.Close
              class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-dim hover:bg-elev hover:text-ink"
              aria-label="Close packet details"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <div class="max-h-[calc(86vh-4rem)] overflow-auto px-4 py-4">
            {#if advertSummary.length}
              <dl class="grid gap-2 sm:grid-cols-3">
                {#each advertSummary as [label, value, sub]}
                  <div class="rounded-md bg-elev px-3 py-2">
                    <dt class="text-xs text-muted">{label}</dt>
                    <dd class="mt-1 break-all text-sm" class:font-mono={label !== 'Name' && label !== 'Type'}>{value ?? '—'}</dd>
                    {#if sub}<dd class="mt-0.5 text-xs text-dim">{sub}</dd>{/if}
                  </div>
                {/each}
                <div class="rounded-md bg-elev px-3 py-2">
                  <dt class="text-xs text-muted">Network</dt>
                  <dd class="mt-1 text-sm">
                    {#if selectedAdvert?.networkId}
                      <a
                        class="inline-flex items-center gap-1.5 text-accent2 hover:underline"
                        href={networkUrl(selectedAdvert.networkId)}
                        rel="noreferrer"
                      >
                        <Flag code={netFlagCode(selectedAdvert.networkId)} class="h-3.5 w-5" />
                        {networkName(selectedAdvert.networkId)}
                      </a>
                    {:else}
                      —
                    {/if}
                  </dd>
                </div>
                <div class="rounded-md bg-elev px-3 py-2">
                  <dt class="text-xs text-muted">Observer ID</dt>
                  <dd class="mt-1 font-mono text-sm">
                    {#if selectedAdvert?.observerId}
                      {@const observerUrl = analyzerObserverUrl(selectedAdvert)}
                      {#if observerUrl}
                        <a
                          class="text-accent2 hover:underline"
                          href={observerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortObserverId(selectedAdvert.observerId)}
                        </a>
                      {:else}
                        {shortObserverId(selectedAdvert.observerId)}
                      {/if}
                    {:else}
                      —
                    {/if}
                  </dd>
                </div>
              </dl>
            {/if}

            {#if selectedPacketLinks.length}
              <div class="mt-4">
                <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Packet in analyzers</div>
                <div class="flex flex-wrap gap-2">
                  {#each selectedPacketLinks as link}
                    <a
                      class="inline-flex items-center gap-1.5 rounded-md border border-edge bg-elev px-2.5 py-1.5 text-sm text-accent2 hover:border-accent hover:text-ink"
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Flag code={netFlagCode(link.networkId)} class="h-3.5 w-5" />
                      {link.name}
                    </a>
                  {/each}
                </div>
              </div>
            {/if}

            {#if selectedAdvertGroup?.adverts?.length > 1}
              <div class="mt-4">
                <div class="mb-2 flex items-baseline justify-between gap-3">
                  <div class="text-xs font-semibold uppercase tracking-wide text-muted">Observations</div>
                  <div class="text-xs text-muted">{observerLabel(selectedAdvertGroup)}</div>
                </div>
                <div class="overflow-x-auto rounded-md border border-edge">
                  <table class="w-full text-xs">
                    <thead class="bg-elev2 text-muted">
                      <tr>
                        <th class="px-3 py-2 text-left font-medium">Received</th>
                        <th class="px-3 py-2 text-left font-medium">Network</th>
                        <th class="px-3 py-2 text-left font-medium">Observer</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-edge">
                      {#each selectedAdvertGroup.adverts as obs}
                        <tr>
                          <td class="whitespace-nowrap px-3 py-2" title={fmtTime(obs.at)}>{fmtAgo(obs.at)}</td>
                          <td class="whitespace-nowrap px-3 py-2">
                            {#if obs.networkId}
                              <a
                                class="inline-flex items-center gap-1.5 text-accent2 hover:underline"
                                href={networkUrl(obs.networkId)}
                                rel="noreferrer"
                              >
                                <Flag code={netFlagCode(obs.networkId)} class="h-3.5 w-5" />
                                {networkName(obs.networkId)}
                              </a>
                            {:else}—{/if}
                          </td>
                          <td class="whitespace-nowrap px-3 py-2 text-dim">
                            <div>{obs.observerName || '—'}</div>
                            {#if obs.observerId}
                              {@const observerUrl = analyzerObserverUrl(obs)}
                              {#if observerUrl}
                                <a
                                  class="font-mono text-[11px] text-accent2 hover:underline"
                                  href={observerUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {shortObserverId(obs.observerId)}
                                </a>
                              {:else}
                                <div class="font-mono text-[11px] text-muted">{shortObserverId(obs.observerId)}</div>
                              {/if}
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            {/if}

            {#if selectedAdvert?.rawHex}
              <div class="mt-4">
                <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Packet</div>
                {#if packetError}
                  <p class="rounded-md border border-edge bg-elev px-3 py-2 text-sm text-warn">{packetError}</p>
                {/if}

                {#if packetSummary.length}
                  <dl class="grid gap-2 sm:grid-cols-3">
                    {#each packetSummary as [label, value]}
                      <div class="rounded-md bg-elev px-3 py-2">
                        <dt class="text-xs text-muted">{label}</dt>
                        <dd class="mt-1 font-mono text-sm">{value ?? '—'}</dd>
                      </div>
                    {/each}
                  </dl>
                {/if}

                <div class="mt-3">
                  <div class="mb-1 text-xs text-muted">Raw packet</div>
                  <pre class="rounded-md bg-elev p-3 font-mono text-xs text-dim whitespace-pre-wrap break-all">{selectedAdvert.rawHex}</pre>
                </div>

                {#if decodedPacket}
                  <div class="mt-3">
                    <div class="mb-1 text-xs text-muted">Decoded packet</div>
                    <div class="shiki-json max-h-80 overflow-auto rounded-md bg-elev">
                      {#if highlightedPacket}
                        {@html highlightedPacket}
                      {:else}
                        <pre class="p-3 font-mono text-xs text-dim">{JSON.stringify(decodedPacket, null, 2)}</pre>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  {/if}
</div>

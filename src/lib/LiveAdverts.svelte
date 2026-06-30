<script module>
  // Surviving copy of the feed, kept at module scope so it persists across
  // navigations (e.g. opening a node and pressing back) and across the search
  // box hiding/showing the homepage. Returning resumes from here instead of an
  // empty list. Lives for the SPA session only — a full reload starts fresh.
  let savedAdverts = [];
  let savedSeq = 0;
</script>

<script>
  // A live, flowing feed of signed adverts observed across the whole mesh,
  // streamed straight from tangleveil's multiplex WebSocket. We ask the relay to
  // pre-filter to ADVERT packets and to dedup the same packet seen by many
  // observers (`?payloadTypes=ADVERT&dedupByContent`), so the client just renders
  // what arrives — no parsing/filtering load here. New adverts fly in at the top.
  import { onMount } from 'svelte';
  import { flip } from 'svelte/animate';
  import { fly } from 'svelte/transition';
  import { base } from '$app/paths';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import { meshNetworks } from '$lib/api.js';
  import { TYPE_LABEL, fmtAgo, shortKey, fmtCoords } from '$lib/format.js';

  // Network catalog (id → details), for resolving the observing network's name +
  // country flag. Loaded once; NetworkPill falls back to the raw id until ready.
  let catalog = $state({});
  meshNetworks().then((c) => (catalog = c));

  const TANGLEVEIL_WS = (
    import.meta.env?.VITE_TANGLEVEIL_WS || 'wss://tangleveil.meshcore.ninja/ws'
  ).replace(/\/+$/, '');

  const MAX = 8; // rolling window of most-recent adverts
  const RELEASE_MS = 500; // throttle: release at most one queued advert per tick
  const MAX_QUEUE = 40; // cap the backlog so a burst can't pile up unbounded

  let adverts = $state(savedAdverts); // resume from the last session if any
  let status = $state('connecting'); // 'connecting' | 'live' | 'offline'
  let now = $state(Date.now() / 1000);

  // Incoming frames can arrive in bursts (especially right after connect); we
  // buffer them here and let `release()` drip them into the visible list one at
  // a time so the feed flows steadily instead of jumping.
  let queue = [];

  let ws;
  let reconnectTimer;
  let backoff = 1000;
  let destroyed = false;
  let seq = savedSeq; // keep advancing keys so restored rows stay unique

  function connect() {
    if (destroyed) return;
    if (status !== 'live') status = adverts.length ? 'live' : 'connecting';
    try {
      ws = new WebSocket(`${TANGLEVEIL_WS}?payloadTypes=ADVERT&dedupByContent`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      backoff = 1000;
      status = 'live';
    };
    ws.onmessage = (ev) => handleFrame(ev.data);
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (destroyed) return;
      status = 'offline';
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000); // capped exponential backoff
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // tangleveil envelope → CoreScope packet → decoded ADVERT payload.
    const data = frame?.payload?.data;
    const p = data?.decoded?.payload;
    if (!p?.pubKey) return;

    const hasGps = !!p.flags?.hasLocation && !(p.lat === 0 && p.lon === 0);
    const advert = {
      key: `${data.hash ?? p.pubKey}-${++seq}`,
      pubkey: p.pubKey,
      name: p.name?.trim() || '(unnamed)',
      type: p.flags?.type ?? 0,
      hasGps,
      lat: p.lat,
      lon: p.lon,
      observer: data.observer_name || '',
      source: frame.source || '',
      // tangleveil source id → network id: extra analyzers for one network get a
      // `-2`, `-3`… suffix, so strip it to recover the catalog network id.
      network: (frame.source || '').replace(/-\d+$/, ''),
      at: Date.now() / 1000
    };
    queue.push(advert);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  }

  // Move one buffered advert into the visible list, oldest-buffered first so the
  // feed stays in arrival order. The `at` stamp is refreshed on release so the
  // "now / Ns ago" age reflects when it actually appears.
  function release() {
    if (!queue.length) return;
    const next = queue.shift();
    next.at = Date.now() / 1000;
    adverts = [next, ...adverts].slice(0, MAX);
  }

  onMount(() => {
    connect();
    const pump = setInterval(release, RELEASE_MS);
    const tick = setInterval(() => (now = Date.now() / 1000), 1000);
    return () => {
      destroyed = true;
      // Stash the current feed so a remount resumes where we left off.
      savedAdverts = adverts;
      savedSeq = seq;
      clearTimeout(reconnectTimer);
      clearInterval(pump);
      clearInterval(tick);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  });
</script>

<section class="mt-10" aria-label="Live adverts from the mesh">
  <div class="mb-3 flex items-center justify-between gap-3">
    <h2 class="flex items-center gap-2 text-sm font-medium text-dim">
      <span class="relative flex h-2 w-2">
        {#if status === 'live'}
          <span
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-accent"></span>
        {:else}
          <span
            class="relative inline-flex h-2 w-2 rounded-full {status === 'connecting'
              ? 'bg-warn'
              : 'bg-bad'}"
          ></span>
        {/if}
      </span>
      Live adverts
      <span class="text-muted">· from across the mesh</span>
    </h2>
    <span class="text-xs text-muted">
      {#if status === 'live'}streaming{:else if status === 'connecting'}connecting…{:else}reconnecting…{/if}
    </span>
  </div>

  {#if adverts.length === 0}
    <div class="rounded-xl border border-edge bg-elev/40 px-4 py-8 text-center text-sm text-muted">
      {#if status === 'offline'}
        Lost connection to the live feed. Reconnecting…
      {:else}
        Waiting for the next signed advert…
      {/if}
    </div>
  {:else}
    <ul class="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-gradient-to-b from-elev/50 to-transparent">
      {#each adverts as a, i (a.key)}
        <li
          class:last-row-fade={i === adverts.length - 1}
          class:fresh={now - a.at < 6}
          animate:flip={{ duration: 250 }}
          in:fly={{ y: -10, duration: 300 }}
        >
          <a
            href="{base}/{a.pubkey}"
            class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elev"
          >
            <NodeIcon type={a.type} size={18} class="shrink-0 text-dim" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate font-medium">{a.name}</span>
                <span class="shrink-0 text-xs capitalize text-muted">{TYPE_LABEL[a.type]}</span>
              </span>
              <span class="flex items-center gap-2">
                <span class="shrink-0 font-mono text-xs text-muted">{shortKey(a.pubkey)}</span>
                {#if a.network}
                  <NetworkPill id={a.network} {catalog} />
                {/if}
              </span>
            </span>
            <span class="hidden shrink-0 text-right text-xs text-dim sm:block">
              {#if a.hasGps}
                <span class="block tabular-nums">{fmtCoords(a.lat, a.lon)}</span>
              {/if}
              {#if a.observer}
                <span class="block max-w-44 truncate" title={`Observed by ${a.observer}`}>
                  via {a.observer}
                </span>
              {/if}
            </span>
            <span class="shrink-0 whitespace-nowrap text-xs text-muted tabular-nums">
              {fmtAgo(a.at, now)}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .last-row-fade {
    -webkit-mask-image: linear-gradient(to bottom, #000 35%, transparent);
    mask-image: linear-gradient(to bottom, #000 35%, transparent);
  }

  /* A new advert lands with a green wash + accent edge that fades out over a few
     seconds, so the eye can tell at a glance how fresh each row is. */
  .fresh {
    animation: advert-fresh 5s ease-out;
  }

  @keyframes advert-fresh {
    0% {
      background-color: color-mix(in srgb, var(--color-accent) 24%, transparent);
      box-shadow: inset 2px 0 0 var(--color-accent);
    }
    100% {
      background-color: transparent;
      box-shadow: inset 2px 0 0 transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fresh {
      animation: none;
    }
  }
</style>

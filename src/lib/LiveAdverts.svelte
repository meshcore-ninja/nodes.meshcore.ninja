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
  import { onMount, tick } from 'svelte';
  import { fly, slide } from 'svelte/transition';
  import { ArrowUp } from '@lucide/svelte';
  import { base } from '$app/paths';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import { meshNetworks } from '$lib/api.js';
  import { newNodeKeys, onNewNode } from '$lib/newNodes.js';
  import { TYPE_LABEL, fmtAgo, shortKey, fmtCoords } from '$lib/format.js';

  // Network catalog (id → details), for resolving the observing network's name +
  // country flag. Loaded once; NetworkPill falls back to the raw id until ready.
  let catalog = $state({});
  meshNetworks().then((c) => (catalog = c));

  const TANGLEVEIL_WS = (
    import.meta.env?.VITE_TANGLEVEIL_WS || 'wss://tangleveil.meshcore.ninja/ws'
  ).replace(/\/+$/, '');

  const MAX = 100; // rolling window of most-recent adverts (scroll to see history)
  const RELEASE_MS = 500; // throttle: release at most one queued advert per tick
  const MAX_QUEUE = 40; // cap the backlog so a burst can't pile up unbounded

  let adverts = $state(savedAdverts); // resume from the last session if any
  let status = $state('connecting'); // 'connecting' | 'live' | 'offline'
  let now = $state(Date.now() / 1000);

  // Scroll/follow state: the feed "follows latest" while pinned to the top
  // (newest first). Once the user scrolls down into history we stop following,
  // hold their position as new rows prepend, and offer a button to jump back.
  let scroller = $state(null);
  let following = $state(true);
  let unseenCount = $state(0); // new adverts arrived while scrolled away
  let pinning = false; // a programmatic scroll-to-top is in flight
  let overflowing = $state(false); // more rows than fit the viewport
  let atBottom = $state(false); // scrolled to the very end of the list
  // The bottom fade only makes sense when there's hidden content below it.
  const showBottomFade = $derived(overflowing && !atBottom);

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

    // While the user is reading history, hold their view steady as the new row
    // prepends (otherwise the content would slide down under them) and tally the
    // unseen arrivals for the "follow latest" button. We anchor to the current
    // top row's element — keyed, so it survives the update — and restore its
    // viewport offset afterwards. (Native overflow-anchor is disabled in CSS so
    // it can't fight this; when following, prepending at scrollTop 0 just stays.)
    const sc = scroller;
    const hold = !following && sc;
    let anchorEl = null;
    let anchorOffset = 0;
    if (hold) {
      anchorEl = sc.querySelector('li');
      if (anchorEl) anchorOffset = anchorEl.offsetTop - sc.scrollTop;
    }

    adverts = [next, ...adverts].slice(0, MAX);

    if (hold) unseenCount += 1;
    tick().then(() => {
      if (hold && scroller && anchorEl?.isConnected) {
        scroller.scrollTop = anchorEl.offsetTop - anchorOffset;
      }
      updateMetrics();
    });
  }

  function updateMetrics() {
    const sc = scroller;
    if (!sc) {
      overflowing = false;
      atBottom = false;
      return;
    }
    overflowing = sc.scrollHeight > sc.clientHeight + 1;
    atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 4;
  }

  function onFeedScroll() {
    updateMetrics();
    const atTop = (scroller?.scrollTop ?? 0) <= 8;
    // While the button-driven scroll is animating to the top, ignore the
    // intermediate positions it passes through — only the arrival matters.
    if (pinning) {
      if (atTop) {
        pinning = false;
        following = true;
        unseenCount = 0;
      }
      return;
    }
    following = atTop;
    if (atTop) unseenCount = 0;
  }

  function followLatest() {
    following = true;
    unseenCount = 0;
    pinning = true;
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Entrance for a new row. A height `slide` reveals it without leaving the gap
  // a translate (`fly`) would. Only animate while following — when the user is
  // reading history we insert instantly so the scroll-anchor math (which assumes
  // the row's full height is present) stays exact and the view doesn't drift.
  function reveal(node, params) {
    return following ? slide(node, { duration: 220 }) : { duration: 0 };
  }

  onMount(() => {
    connect();
    // Keep the shared /api/live socket alive while the feed is shown, so newly
    // observed pubkeys land in `newNodeKeys` and matching rows light up.
    const stopNew = onNewNode();
    const pump = setInterval(release, RELEASE_MS);
    const tick = setInterval(() => (now = Date.now() / 1000), 1000);
    requestAnimationFrame(updateMetrics); // restored feed may already overflow
    return () => {
      destroyed = true;
      stopNew();
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
    <div class="relative">
      {#if !following}
        <button
          type="button"
          onclick={followLatest}
          transition:fly={{ y: -8, duration: 200 }}
          class="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/50 bg-accent px-3 py-1.5 text-xs font-medium text-bg shadow-lg shadow-black/30 transition hover:brightness-110"
        >
          <ArrowUp size={14} />
          {unseenCount > 0
            ? `${unseenCount} new advert${unseenCount === 1 ? '' : 's'}`
            : 'Follow latest'}
        </button>
      {/if}
      <!-- Bottom fade: a gradient overlay (rather than a CSS mask) so it can
           ease in/out instead of snapping when the list starts/stops overflowing. -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-[5.5rem] rounded-b-xl bg-gradient-to-t from-bg to-transparent transition-opacity duration-300"
        class:opacity-0={!showBottomFade}
        aria-hidden="true"
      ></div>
      <ul
        bind:this={scroller}
        onscroll={onFeedScroll}
        class="adverts-scroll divide-y divide-edge rounded-xl border border-edge bg-gradient-to-b from-elev/50 to-transparent"
      >
      {#each adverts as a, i (a.key)}
        {@const isNew = newNodeKeys.has(a.pubkey)}
        <li
          class:fresh={!isNew && now - a.at < 6}
          class:new-node={isNew}
          in:reveal
        >
          <a
            href="{base}/{a.pubkey}"
            class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elev"
          >
            <NodeIcon type={a.type} size={18} class="shrink-0 text-dim" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate font-medium">{a.name}</span>
                {#if isNew}
                  <span
                    class="new-badge shrink-0 rounded-full border border-[#f0c14b]/60 bg-[#f0c14b]/20 px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-wide text-[#f0c14b]"
                    title="First time this node has ever been observed"
                  >
                    ✦ New
                  </span>
                {/if}
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
    </div>
  {/if}
</section>

<style>
  /* Scrollable feed that keeps up to MAX rows of history. Scrollbars are hidden
     and the bottom edge fades, so older rows dissolve into "there's more below"
     rather than ending in a hard line. */
  .adverts-scroll {
    max-height: 30rem;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    overflow-anchor: none;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .adverts-scroll::-webkit-scrollbar {
    display: none;
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

  /* A first-ever-seen node gets the full golden treatment — a thick gold edge,
     a gold-tinted fill, a gold hairline border and an outer glow — so it stands
     out unmistakably from merely-recent rows. */
  .new-node {
    background-color: color-mix(in srgb, #f0c14b 13%, transparent);
    box-shadow:
      inset 3px 0 0 #f0c14b,
      inset 0 0 0 1px color-mix(in srgb, #f0c14b 45%, transparent),
      0 0 18px color-mix(in srgb, #f0c14b 24%, transparent);
  }

  .new-node:hover {
    background-color: color-mix(in srgb, #f0c14b 18%, transparent);
  }

  .new-badge {
    animation: new-badge-in 0.5s ease-out;
    box-shadow: 0 0 10px color-mix(in srgb, #f0c14b 40%, transparent);
  }

  @keyframes new-badge-in {
    0% {
      opacity: 0;
      transform: scale(0.6);
    }
    60% {
      opacity: 1;
      transform: scale(1.12);
    }
    100% {
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .new-badge {
      animation: none;
    }
  }
</style>

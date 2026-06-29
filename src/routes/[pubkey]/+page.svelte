<script>
  import { onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Dialog, Tooltip } from 'bits-ui';
  import { ChevronRight, X } from '@lucide/svelte';
  import { MeshCoreDecoder, Utils } from '@michaelhart/meshcore-decoder';
  import {
    nodeDetail,
    nodeAdverts,
    nodeLinks,
    nodeNetworkStats,
    nodeAdvertActivity,
    nodeMapPublishes,
    meshNetworks
  } from '$lib/api.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NodeMap from '$lib/NodeMap.svelte';
  import AddContactQR from '$lib/AddContactQR.svelte';
  import Flag from '$lib/Flag.svelte';
  import { networkFlags, networkUrl } from '$lib/flags.js';
  import { TYPE_LABEL, fmtTime, fmtAgo, fmtCoords, shortKey, shortKey8, shortKeyWide } from '$lib/format.js';

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
  let publishDialogOpen = $state(false);
  let selectedPublish = $state(null);
  let selectedAdvert = $state(null);
  let selectedAdvertGroup = $state(null);
  let decodedPacket = $state(null);
  let highlightedPacket = $state('');
  let highlightedPublishParams = $state('');
  let packetError = $state('');
  let highlightSeq = 0;
  let publishHighlightSeq = 0;
  let highlighterPromise;

  // Observed neighbours, per-network advert stats, and the network catalog.
  let links = $state([]);
  let linksTotal = $state(0);
  let netStats = $state({}); // networkId -> { adverts, firstAt, lastAt }
  let advertActivity = $state([]);
  let mapPublishes = $state([]); // captured map.meshcore.io snapshots, newest first
  let catalog = $state({});
  let showAllLinks = $state(false);
  let neighborSort = $state('');
  let neighborSortDir = $state('asc');
  let heatmapWidth = $state(0);
  let heatmapHoveredDay = $state(null);
  let heatmapGridEl = $state(null);
  let heatmapResizeObserver;

  const HEATMAP_CELL = 16; // 1rem hit target; 12px visual cell leaves a virtual gap
  const HEATMAP_SIDE_PAD = 24; // px-3 left + right on the card
  const HEATMAP_WEEKDAY_COL = 32; // w-6 labels + gap-2 before the grid

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
    advertActivity = [];
    mapPublishes = [];
    showAllLinks = false;
    neighborSort = '';
    neighborSortDir = 'asc';

    if (!validKey) {
      notFound = true;
      loading = false;
      return;
    }

    Promise.all([nodeDetail(pk), nodeAdverts(pk, { limit: 10 })])
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
    nodeAdvertActivity(pk, { days: 365 })
      .then((d) => {
        if (pk !== pubkey) return;
        advertActivity = d.activity ?? [];
      })
      .catch(() => {});
    nodeMapPublishes(pk)
      .then((d) => {
        if (pk !== pubkey) return;
        mapPublishes = d.publishes ?? [];
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
      const hist = await nodeAdverts(pubkey, { limit: 100, before: nextBefore });
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

  function hasValidCoords(item) {
    return !!item?.hasGps && Number.isFinite(item.lat) && Number.isFinite(item.lon);
  }

  function linkHasLocation(link) {
    return hasValidCoords(link?.neighbor);
  }

  function distanceKm(aLat, aLon, bLat, bLon) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthKm = 6371;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earthKm * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function linkDistanceKm(link) {
    if (!hasValidCoords(node) || !linkHasLocation(link)) return null;
    return distanceKm(node.lat, node.lon, link.neighbor.lat, link.neighbor.lon);
  }

  function fmtDistance(km) {
    if (km == null) return '—';
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  }

  function distanceUnavailableReason(link) {
    if (!hasValidCoords(node)) return 'This node doesn’t send coordinates';
    if (!linkHasLocation(link)) return 'Linked node doesn’t send coordinates';
    return '';
  }

  function utcDayStart(unix = Date.now() / 1000) {
    return Math.floor(unix / 86400) * 86400;
  }

  function heatmapDays() {
    const counts = new Map(advertActivity.map((d) => [d.day, d.adverts]));
    const today = utcDayStart();
    const start = today - 364 * 86400;
    const days = [];
    for (let day = start; day <= today; day += 86400) {
      days.push({ day, adverts: counts.get(day) || 0 });
    }
    return days;
  }

  function heatmapWeeks() {
    const days = heatmapDays();
    const firstDow = new Date(days[0].day * 1000).getUTCDay();
    const cells = [
      ...Array.from({ length: firstDow }, () => null),
      ...days
    ];
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }
    return weeks;
  }

  function visibleHeatmapWeeks() {
    const weeks = heatmapWeeks();
    return weeks.slice(Math.max(0, weeks.length - visibleHeatmapWeekCount()));
  }

  function visibleHeatmapWeekCount() {
    if (!heatmapWidth) {
      return Math.min(heatmapWeeks().length, 16);
    }
    const available = heatmapWidth - HEATMAP_SIDE_PAD - HEATMAP_WEEKDAY_COL;
    return Math.max(
      8,
      Math.min(heatmapWeeks().length, Math.floor(available / HEATMAP_CELL))
    );
  }

  function visibleHeatmapDayCount() {
    return Math.min(365, visibleHeatmapWeeks().length * 7);
  }

  function heatmapMonthLabels() {
    const weeks = visibleHeatmapWeeks();
    const labels = [];
    let previous = '';
    for (const week of weeks) {
      const firstDay = week.find(Boolean);
      if (!firstDay) {
        labels.push('');
        continue;
      }
      const month = new Date(firstDay.day * 1000).toLocaleString('en', {
        month: 'short',
        timeZone: 'UTC'
      });
      labels.push(month !== previous ? month : '');
      previous = month;
    }
    return labels;
  }

  function heatmapLevel(count) {
    if (!count) return 0;
    const max = Math.max(...advertActivity.map((d) => d.adverts), 1);
    if (count >= max) return 4;
    if (count >= max * 0.6) return 3;
    if (count >= max * 0.3) return 2;
    return 1;
  }

  function heatmapDate(day) {
    return new Date(day.day * 1000).toISOString().slice(0, 10);
  }

  function advertCountLabel(count) {
    return `${count} advert${count === 1 ? '' : 's'}`;
  }

  function heatmapTitle(day) {
    return `${heatmapDate(day)}: ${advertCountLabel(day.adverts)}`;
  }

  function heatmapWeekday(day) {
    return new Date(day.day * 1000).toLocaleString('en', {
      weekday: 'long',
      timeZone: 'UTC'
    });
  }

  function heatmapTooltipDate(day) {
    return new Date(day.day * 1000).toLocaleString('en', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  function heatmapTooltipText(day) {
    const date = heatmapTooltipDate(day);
    return `${heatmapWeekday(day)}, ${date}`;
  }

  function heatmapTooltipCount(day) {
    return advertCountLabel(day.adverts);
  }

  function heatmapColor(level) {
    return [
      'bg-elev2',
      'bg-accent/25',
      'bg-accent/45',
      'bg-accent/70',
      'bg-accent'
    ][level];
  }

  function heatmapDayAtPointer(event) {
    const grid = heatmapGridEl;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? event;
    const col = Math.floor((point.clientX - rect.left) / HEATMAP_CELL);
    const row = Math.floor((point.clientY - rect.top) / HEATMAP_CELL);
    const weeks = visibleHeatmapWeeks();
    if (col < 0 || col >= weeks.length || row < 0 || row > 6) return null;
    return weeks[col]?.[row] ?? null;
  }

  function onHeatmapPointerMove(event) {
    heatmapHoveredDay = heatmapDayAtPointer(event);
  }

  function onHeatmapPointerLeave() {
    heatmapHoveredDay = null;
  }

  function onHeatmapTouchEnd(event) {
    // Keep the last touched cell highlighted until another interaction.
    heatmapHoveredDay = heatmapDayAtPointer(event) ?? heatmapHoveredDay;
  }

  function heatmapCellHovered(day) {
    return heatmapHoveredDay?.day === day.day;
  }

  function bindHeatmapMeasure(node) {
    const update = () => {
      heatmapWidth = node.clientWidth;
    };
    update();
    requestAnimationFrame(update);
    heatmapResizeObserver?.disconnect();
    heatmapResizeObserver = new ResizeObserver(() => update());
    heatmapResizeObserver.observe(node);
    return {
      destroy() {
        heatmapResizeObserver?.disconnect();
      }
    };
  }

  onDestroy(() => {
    heatmapResizeObserver?.disconnect();
  });

  function sortNeighbors(key) {
    if (neighborSort === key) {
      neighborSortDir = neighborSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      neighborSort = key;
      neighborSortDir = key === 'name' || key === 'pubkey' || key === 'distance' ? 'asc' : 'desc';
    }
    showAllLinks = true;
  }

  function sortMark(key) {
    if (neighborSort !== key) return '';
    return neighborSortDir === 'asc' ? ' ↑' : ' ↓';
  }

  function sortedNeighborLinks() {
    if (!neighborSort) return links;
    return [...links].sort((a, b) => compareNeighbor(a, b, neighborSort, neighborSortDir));
  }

  function visibleNeighborLinks() {
    const sorted = sortedNeighborLinks();
    return showAllLinks || neighborSort ? sorted : sorted.slice(0, 10);
  }

  function compareNeighbor(a, b, key, dir) {
    const direction = dir === 'desc' ? -1 : 1;
    let result = 0;
    if (key === 'name') {
      result = (a.neighbor?.name || shortKey(a.neighbor?.pubkey) || '').localeCompare(
        b.neighbor?.name || shortKey(b.neighbor?.pubkey) || '',
        undefined,
        { sensitivity: 'base' }
      );
    } else if (key === 'pubkey') {
      result = (a.neighbor?.pubkey || '').localeCompare(b.neighbor?.pubkey || '');
    } else if (key === 'distance') {
      return compareNullableNumber(linkDistanceKm(a), linkDistanceKm(b), direction);
    } else if (key === 'packets') {
      result = (a.packetCount || 0) - (b.packetCount || 0);
    } else if (key === 'last') {
      result = (a.lastSeen || 0) - (b.lastSeen || 0);
    }
    return result * direction;
  }

  function compareNullableNumber(a, b, direction) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * direction;
  }

  // Upstream map.meshcore.io timestamps are RFC3339 strings; render them like
  // fmtTime (which takes unix seconds). Falls back to the raw value if unparseable.
  function fmtPublishDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  }

  function networkName(id) {
    const n = catalog[id];
    return n?.short_name || n?.name || id || '—';
  }

  function cleanUrl(url) {
    return url?.replace(/\/+$/, '') || '';
  }

  function analyzerForAdvert(advert) {
    const analyzers = catalog[advert?.networkId]?.analyzers ?? [];
    if (!analyzers.length) return null;
    if (advert?.analyzerName) {
      return (
        analyzers.find((a) => a.name === advert.analyzerName) ||
        analyzers.find((a) => a.id === advert.analyzerName) ||
        null
      );
    }
    return analyzers[0] || null;
  }

  function analyzerName(advert) {
    return advert?.analyzerName || analyzerForAdvert(advert)?.name || '—';
  }

  function analyzerGroupLabel(group) {
    if (!group?.adverts?.length) return '—';
    const names = new Set(group.adverts.map((advert) => analyzerName(advert)).filter((name) => name !== '—'));
    if (names.size > 1) return `${names.size} analyzers`;
    return [...names][0] || analyzerName(group.first);
  }

  function analyzerBase(advert) {
    return cleanUrl(analyzerForAdvert(advert)?.url);
  }

  function analyzerPacketUrl(advert, hash = advert?.hash) {
    const base = analyzerBase(advert);
    if (!base || !hash) return '';
    return `${base}/#/packets/${encodeURIComponent(hash)}`;
  }

  function groupAnalyzerPacketUrl(group) {
    if (!group?.hash) return '';
    for (const advert of group.adverts) {
      const url = analyzerPacketUrl(advert, group.hash);
      if (url) return url;
    }
    return '';
  }

  function analyzerObserverUrl(advert) {
    const base = analyzerBase(advert);
    if (!base || !advert?.observerId) return '';
    return `${base}/#/observers/${encodeURIComponent(advert.observerId)}`;
  }

  function analyzerPacketLinks(group) {
    if (!group?.hash) return [];
    const seen = new Set();
    const out = [];
    for (const advert of group.adverts) {
      const analyzer = analyzerForAdvert(advert);
      const base = cleanUrl(analyzer?.url);
      if (!base) continue;
      const key = `${advert.networkId || ''}\0${analyzer.name || advert.analyzerName || base}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        networkId: advert.networkId,
        name: analyzer.name || advert.analyzerName || networkName(advert.networkId),
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

  function openPublishDetails(pub) {
    if (!pub) return;
    selectedPublish = pub;
    highlightedPublishParams = '';
    highlightPublishParams(publishParamsText(pub));
    publishDialogOpen = true;
  }

  function publishParamsText(pub) {
    if (!pub?.params) return '';
    try {
      const p = typeof pub.params === 'string' ? JSON.parse(pub.params) : pub.params;
      if (!p || (typeof p === 'object' && !Object.keys(p).length)) return '';
      return JSON.stringify(p, null, 2);
    } catch {
      return String(pub.params);
    }
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

  async function highlightPublishParams(text) {
    const seq = ++publishHighlightSeq;
    if (!text) return;
    try {
      const h = await highlighter();
      const html = h.codeToHtml(text, {
        lang: 'json',
        theme: 'github-dark-default'
      });
      if (seq === publishHighlightSeq) highlightedPublishParams = html;
    } catch {
      if (seq === publishHighlightSeq) highlightedPublishParams = '';
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

  // mapOnly is a node we only know from the map.meshcore.io directory — our
  // analyzers have never observed it (its profile is built from the mirror).
  const mapOnly = $derived(node?.source === 'map');
  const MAP_SITE = 'https://map.meshcore.io';

  // Newest / oldest captured map publish (the API returns them newest-first).
  const latestPublish = $derived(mapPublishes[0] ?? null);

  // Radio (LoRa) settings, sourced from the map.meshcore.io directory's params —
  // adverts don't carry these. Taken from the most recent publish that has them.
  const radio = $derived.by(() => {
    for (const p of mapPublishes) {
      const params = p?.params;
      if (params && typeof params === 'object') {
        const { freq, bw, sf, cr } = params;
        if (freq != null || bw != null || sf != null || cr != null) {
          return { freq, bw, sf, cr };
        }
      }
    }
    return null;
  });

  const firstCaptured = $derived(
    mapPublishes.length ? mapPublishes[mapPublishes.length - 1].firstCapturedAt || 0 : 0
  );

  // A publish's effective time, in unix seconds: when the map entry was last
  // updated/created, falling back to when we captured it. The map's own
  // last_advert is intentionally not used here — it can be a bogus future value.
  function publishTime(p) {
    if (!p) return 0;
    const t = Date.parse(p.updatedDate || p.insertedDate || '');
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
    return p.firstCapturedAt || 0;
  }

  // A unix time we'd trust as "in the past" — guards against the map publishing a
  // bogus future last_advert that would otherwise read as "now".
  const sane = (t) => (t && t <= Date.now() / 1000 ? t : 0);

  // "Last heard" spans both signal types: the newest of any advert or any
  // observed link (network activity). For a map-only node we've never observed,
  // there is nothing to "hear" — fall back to the last map publish instead.
  const lastLinkSeen = $derived(links.reduce((m, l) => Math.max(m, l.lastSeen || 0), 0));
  const lastHeard = $derived.by(() => {
    if (!node) return 0;
    if (mapOnly) return publishTime(latestPublish) || sane(node.lastAdvertAt || 0);
    return Math.max(node.lastAdvertAt || 0, lastLinkSeen);
  });

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

  const publishSummary = $derived(
    selectedPublish
      ? [
          ['Captured', fmtTime(selectedPublish.firstCapturedAt), fmtAgo(selectedPublish.firstCapturedAt)],
          ...(selectedPublish.lastCapturedAt &&
          selectedPublish.lastCapturedAt !== selectedPublish.firstCapturedAt
            ? [
                [
                  'Last captured',
                  fmtTime(selectedPublish.lastCapturedAt),
                  fmtAgo(selectedPublish.lastCapturedAt)
                ]
              ]
            : []),
          ['Name', selectedPublish.advName || '—'],
          ['Type', selectedPublish.typeName || TYPE_LABEL[selectedPublish.type] || 'unknown'],
          [
            'Location',
            selectedPublish.hasGps ? fmtCoords(selectedPublish.advLat, selectedPublish.advLon) : '—'
          ],
          [
            'Last advert',
            selectedPublish.lastAdvertAt ? fmtTime(selectedPublish.lastAdvertAt) : '—',
            selectedPublish.lastAdvert || ''
          ],
          ['Source', selectedPublish.source || '—'],
          ['Inserted', fmtPublishDate(selectedPublish.insertedDate)],
          ['Updated', fmtPublishDate(selectedPublish.updatedDate)],
          ['Inserted by', selectedPublish.insertedBy || '—'],
          ['Updated by', selectedPublish.updatedBy || '—']
        ]
      : []
  );

  const selectedPublishParams = $derived(publishParamsText(selectedPublish));

  const selectedPacketLinks = $derived(analyzerPacketLinks(selectedAdvertGroup));
</script>

<svelte:head>
  <title>{node?.name || 'Node'} — MeshCore Nodes</title>
</svelte:head>

{#if loading}
  <!-- Full page-area loader (everything below the header) while the node loads. -->
  <div class="flex flex-1 items-center justify-center px-4 py-10">
    <div role="status" aria-label="Loading node" class="flex flex-col items-center gap-3 text-dim">
      <span class="h-9 w-9 animate-spin rounded-full border-2 border-edge border-t-accent"></span>
      <span class="text-sm">Loading node…</span>
    </div>
  </div>
{:else}
<div class="mx-auto max-w-6xl w-full min-w-0 px-4 py-6">
    {#if notFound}
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
      <!-- Map + QR: below main content on mobile, sticky sidebar on desktop -->
      <aside class="order-2 space-y-6 lg:order-2 lg:sticky lg:top-6">
        {#if radio}
          <section>
            <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Radio</h2>
            <div class="grid grid-cols-2 gap-2 rounded-xl border border-edge bg-elev p-3">
              {#snippet radioStat(label, value)}
                <div class="rounded-lg bg-bg px-3 py-2">
                  <div class="text-xs text-muted">{label}</div>
                  <div class="mt-0.5 font-mono text-sm font-semibold">{value}</div>
                </div>
              {/snippet}
              {@render radioStat('Frequency', radio.freq != null ? `${radio.freq} MHz` : '—')}
              {@render radioStat('Bandwidth', radio.bw != null ? `${radio.bw} kHz` : '—')}
              {@render radioStat('Spreading', radio.sf != null ? `SF${radio.sf}` : '—')}
              {@render radioStat('Coding rate', radio.cr != null ? `4/${radio.cr}` : '—')}
            </div>
            <p class="mt-1.5 text-[11px] text-muted">From the map.meshcore.io directory.</p>
          </section>
        {/if}

        <section>
          <div class="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Location</h2>
            {#if node.hasGps}
              <span class="font-mono text-xs text-dim break-all sm:break-normal sm:whitespace-nowrap">{fmtCoords(node.lat, node.lon)}</span>
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
              Open on map.meshcore.ninja ↗
            </a>
          {/if}
        </section>

        <AddContactQR {pubkey} name={node.name} type={node.type} />
      </aside>

      <!-- Identity, overview, networks, activity, neighbours -->
      <div class="order-1 lg:order-1 lg:col-span-2 space-y-6 min-w-0">
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
                  {mapOnly ? 'Last map publish' : 'Last heard'} {fmtAgo(lastHeard)}
                </span>
              </div>
            </div>
          </div>

          <!-- Public key -->
          <div class="mt-5">
            <div class="text-[10px] uppercase tracking-wide text-muted mb-1">Public key</div>
            <div class="flex items-center gap-2 rounded-lg bg-bg border border-edge px-3 py-2">
              <span class="flex-1 min-w-0 font-mono text-xs sm:text-sm text-dim">
                <span class="truncate sm:hidden" title={pubkey}>{shortKeyWide(pubkey)}</span>
                <span class="hidden sm:block overflow-x-auto whitespace-nowrap">{pubkey}</span>
              </span>
              <button onclick={copyKey} class="shrink-0 text-xs text-dim hover:text-ink border border-edge rounded px-2 py-0.5">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </header>

        {#if mapOnly}
          <div class="rounded-xl border border-accent2/30 bg-accent2/5 px-4 py-3 text-sm text-dim">
            This node hasn’t been observed by our analyzers yet. The details below are
            mirrored from the
            <a href={MAP_SITE} target="_blank" rel="noreferrer" class="text-accent2 hover:underline">map.meshcore.io</a>
            directory — see <a href="#map-publishes" class="text-accent2 hover:underline">Map publishes</a> below.
          </div>
        {/if}

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
            {#if mapOnly}
              {@const mapAdvert = sane(node.lastAdvertAt || 0)}
              {@render stat('First captured', fmtAgo(firstCaptured), fmtTime(firstCaptured))}
              {@render stat('Last map publish', fmtAgo(lastHeard), 'from directory')}
              {@render stat('Last advert', mapAdvert ? fmtAgo(mapAdvert) : '—', mapAdvert ? `${fmtTime(mapAdvert)} · per map` : 'unknown')}
              {@render stat('Publishes', mapPublishes.length ? String(mapPublishes.length) : '—', 'captured')}
              {@render stat('Location', node.hasGps ? fmtCoords(node.lat, node.lon) : '—', node.hasGps ? 'from map' : 'no coordinates')}
            {:else}
              {@render stat('First seen', fmtAgo(node.firstAdvertAt), fmtTime(node.firstAdvertAt))}
              {@render stat('Last heard', fmtAgo(lastHeard), 'advert or link')}
              {@render stat('Last advert', fmtAgo(node.lastAdvertAt), fmtTime(node.lastAdvertAt))}
              {@render stat('Adverts', node.advertCount.toLocaleString(), 'observed total')}
              {@render stat('Networks', String((node.networks ?? []).length), 'heard on')}
              {@render stat('Links', linksTotal ? linksTotal.toLocaleString() : '—', 'neighbours')}
            {/if}
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
                  class="group flex flex-col gap-1 rounded-lg bg-elev px-3 py-2 hover:bg-elev2 transition-colors sm:flex-row sm:items-center sm:gap-2.5"
                >
                  <span class="flex min-w-0 items-center gap-2.5">
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
                  </span>
                  {#if n.lastAt}
                    <span class="text-xs text-dim sm:shrink-0 sm:whitespace-nowrap sm:text-right" title={fmtTime(n.lastAt)}>
                      {fmtAgo(n.lastAt)} ({n.adverts.toLocaleString()})
                    </span>
                  {/if}
                </a>
              {/each}
            </div>
          </section>
        {/if}

        <section>
          <div class="mb-2 flex items-baseline justify-between gap-3">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Advert activity</h2>
            <span class="text-xs text-muted">last {visibleHeatmapDayCount()} days</span>
          </div>
          <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
          <div class="rounded-lg bg-elev px-3 py-3 min-w-0" use:bindHeatmapMeasure>
            <div class="overflow-x-auto pb-1">
              <div class="min-w-max">
                <div
                  class="ml-8 mb-1 grid text-[10px] text-muted"
                  style={`grid-template-columns: repeat(${visibleHeatmapWeeks().length}, 1rem);`}
                >
                  {#each heatmapMonthLabels() as month}
                    <div class="h-3 whitespace-nowrap">{month}</div>
                  {/each}
                </div>
                <div class="flex gap-2">
                  <div class="grid w-6 shrink-0 grid-rows-7 pt-0.5 text-[10px] leading-3 text-muted">
                    <div class="h-4"></div>
                    <div class="flex h-4 items-center">Mon</div>
                    <div class="h-4"></div>
                    <div class="flex h-4 items-center">Wed</div>
                    <div class="h-4"></div>
                    <div class="flex h-4 items-center">Fri</div>
                    <div class="h-4"></div>
                  </div>
                  <div
                    bind:this={heatmapGridEl}
                    role="img"
                    aria-label="Advert activity heatmap"
                    class="grid grid-flow-col grid-rows-7 touch-manipulation"
                    style={`grid-template-columns: repeat(${visibleHeatmapWeeks().length}, 1rem);`}
                    onmousemove={onHeatmapPointerMove}
                    onmouseleave={onHeatmapPointerLeave}
                    ontouchstart={onHeatmapPointerMove}
                    ontouchmove={onHeatmapPointerMove}
                    ontouchend={onHeatmapTouchEnd}
                  >
                    {#each visibleHeatmapWeeks() as week}
                      {#each week as day}
                        {#if day}
                          <Tooltip.Root open={heatmapCellHovered(day)}>
                            <Tooltip.Trigger
                              tabindex={-1}
                              aria-label={heatmapTitle(day)}
                              class="pointer-events-none flex h-4 w-4 items-center justify-center border-0 bg-transparent p-0 focus-visible:outline-none"
                            >
                              <span
                                aria-hidden="true"
                                class={`block h-3 w-3 rounded-[2px] border ${heatmapCellHovered(day) ? 'border-accent' : 'border-transparent'} ${heatmapColor(heatmapLevel(day.adverts))}`}
                              ></span>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content
                                side="top"
                                sideOffset={6}
                                class="z-50 rounded-md border border-edge bg-elev2 px-2.5 py-1.5 text-xs text-ink shadow-lg shadow-black/30"
                              >
                                <div class="font-medium">{heatmapTooltipText(day)}</div>
                                <div class="mt-0.5 text-muted">{heatmapTooltipCount(day)}</div>
                                <Tooltip.Arrow class="fill-elev2" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        {:else}
                          <span class="block h-4 w-4"></span>
                        {/if}
                      {/each}
                    {/each}
                  </div>
                </div>
              </div>
            </div>
            <div class="mt-2 flex items-center justify-start gap-1 text-[10px] text-muted">
              <span>Less</span>
              {#each [0, 1, 2, 3, 4] as level}
                <span class={`h-3 w-3 rounded-[2px] ${heatmapColor(level)}`}></span>
              {/each}
              <span>More</span>
            </div>
          </div>
          </Tooltip.Provider>
        </section>

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
                    <th class="text-left font-medium px-3 py-2">
                      <button class="hover:text-ink" onclick={() => sortNeighbors('name')}>
                        Neighbour{sortMark('name')}
                      </button>
                    </th>
                    <th class="text-left font-medium px-3 py-2">
                      <button class="hover:text-ink" onclick={() => sortNeighbors('pubkey')}>
                        Public key{sortMark('pubkey')}
                      </button>
                    </th>
                    <th class="text-right font-medium px-3 py-2">
                      <button class="ml-auto block hover:text-ink" onclick={() => sortNeighbors('distance')}>
                        Distance{sortMark('distance')}
                      </button>
                    </th>
                    <th class="text-right font-medium px-3 py-2">
                      <button class="ml-auto block hover:text-ink" onclick={() => sortNeighbors('packets')}>
                        Packets{sortMark('packets')}
                      </button>
                    </th>
                    <th class="text-left font-medium px-3 py-2">
                      <button class="hover:text-ink" onclick={() => sortNeighbors('last')}>
                        Last heard{sortMark('last')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-edge">
                  {#each visibleNeighborLinks() as l}
                    {@const dist = linkDistanceKm(l)}
                    <tr
                      class="cursor-pointer hover:bg-elev"
                      onclick={() => goto(`${base}/${l.neighbor.pubkey}`)}
                    >
                      <td
                        class="px-3 py-2 max-w-[14rem] truncate text-accent2"
                        title={l.neighbor.name}
                      >
                        <span class="inline-flex items-center gap-1.5 min-w-0">
                          <span class="shrink-0 text-dim" title={TYPE_LABEL[l.neighbor.type]}>
                            <NodeIcon type={l.neighbor.type} size={14} />
                          </span>
                          <span class="truncate">{l.neighbor.name || shortKey(l.neighbor.pubkey)}</span>
                        </span>
                      </td>
                      <td
                        class="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted"
                        title={l.neighbor.pubkey}
                      >
                        {shortKey(l.neighbor.pubkey)}
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap text-right text-xs">
                        {#if dist != null}
                          <span class="font-mono">{fmtDistance(dist)}</span>
                        {:else}
                          <span class="text-muted" title={distanceUnavailableReason(l)}>No coordinates</span>
                        {/if}
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap text-right font-mono text-xs">{l.packetCount.toLocaleString()}</td>
                      <td class="px-3 py-2 whitespace-nowrap text-xs text-dim" title={fmtTime(l.lastSeen)}>
                        {fmtAgo(l.lastSeen)}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if !showAllLinks && !neighborSort && links.length > 10}
              <button
                onclick={() => (showAllLinks = true)}
                class="mt-3 rounded-md border border-edge px-4 py-2 text-sm text-dim hover:text-ink hover:border-accent"
              >
                Show all {links.length}
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

    <!-- Advert history (full width) — only when the node has observed adverts -->
    {#if adverts.length}
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
              <th class="text-left font-medium px-3 py-2">Analyzer</th>
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
                <td class="px-3 py-2 whitespace-nowrap text-xs">
                  {#if groupAnalyzerPacketUrl(group)}
                    <a
                      class="text-accent2 hover:underline"
                      href={groupAnalyzerPacketUrl(group)}
                      onclick={(event) => event.stopPropagation()}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {analyzerGroupLabel(group)}
                    </a>
                  {:else}
                    <span class="text-dim">{analyzerGroupLabel(group)}</span>
                  {/if}
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
                    <td class="px-3 py-2 whitespace-nowrap text-xs">
                      {#if analyzerPacketUrl(detail)}
                        <a
                          class="text-accent2 hover:underline"
                          href={analyzerPacketUrl(detail)}
                          onclick={(event) => event.stopPropagation()}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {analyzerName(detail)}
                        </a>
                      {:else}
                        <span class="text-dim">{analyzerName(detail)}</span>
                      {/if}
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
    {/if}

    <!-- Map publishes (captured map.meshcore.io directory snapshots) -->
    {#if mapPublishes.length}
      <section id="map-publishes" class="mt-8 scroll-mt-6">
        <h2 class="mb-2 text-xs uppercase tracking-wide text-muted">
          <span class="font-semibold">Map publishes</span>
          <span> on </span>
          <a
            href={MAP_SITE}
            target="_blank"
            rel="noreferrer"
            class="normal-case text-accent2 hover:underline"
          >map.meshcore.io ↗</a>
        </h2>
        <p class="mb-2 text-xs text-muted">
          Distinct snapshots of this node’s entry in the
          <a href={MAP_SITE} target="_blank" rel="noreferrer" class="text-accent2 hover:underline">map.meshcore.io</a>
          directory we’ve captured over time — newest first.
        </p>
        <div class="overflow-x-auto rounded-xl border border-edge">
          <table class="w-full text-sm">
            <thead class="bg-elev2 text-muted text-xs">
              <tr>
                <th class="text-left font-medium px-3 py-2">Captured</th>
                <th class="text-left font-medium px-3 py-2">Name</th>
                <th class="text-left font-medium px-3 py-2 w-12">Type</th>
                <th class="text-left font-medium px-3 py-2">Location</th>
                <th class="text-left font-medium px-3 py-2">Last advert</th>
                <th class="text-left font-medium px-3 py-2">Source</th>
                <th class="text-left font-medium px-3 py-2">Inserted</th>
                <th class="text-left font-medium px-3 py-2">Updated</th>
                <th class="text-left font-medium px-3 py-2">Submitted by</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-edge">
              {#each mapPublishes as pub (pub.firstCapturedAt + '-' + (pub.updatedDate || '') + '-' + pub.advName)}
                <tr
                  class="cursor-pointer hover:bg-elev"
                  onclick={() => openPublishDetails(pub)}
                >
                  <td class="px-3 py-2 whitespace-nowrap text-xs" title={fmtTime(pub.firstCapturedAt)}>
                    {fmtAgo(pub.firstCapturedAt)}
                  </td>
                  <td class="px-3 py-2 max-w-[16rem] truncate" title={pub.advName}>{pub.advName || '—'}</td>
                  <td class="px-3 py-2 whitespace-nowrap">
                    <span title={TYPE_LABEL[pub.type]} aria-label={TYPE_LABEL[pub.type]}>
                      <NodeIcon type={pub.type} size={15} class="text-dim" />
                    </span>
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {pub.hasGps ? fmtCoords(pub.advLat, pub.advLon) : '—'}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {pub.lastAdvertAt ? fmtTime(pub.lastAdvertAt) : '—'}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap text-xs text-dim">{pub.source || '—'}</td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs" title={pub.insertedDate}>
                    {fmtPublishDate(pub.insertedDate)}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs" title={pub.updatedDate}>
                    {fmtPublishDate(pub.updatedDate)}
                  </td>
                  <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-dim" title={pub.updatedBy || pub.insertedBy}>
                    {pub.updatedBy || pub.insertedBy ? shortKey8(pub.updatedBy || pub.insertedBy) : '—'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

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
                  <dt class="text-xs text-muted">Analyzer</dt>
                  <dd class="mt-1 text-sm">
                    {#if analyzerPacketUrl(selectedAdvert)}
                      <a
                        class="text-accent2 hover:underline"
                        href={analyzerPacketUrl(selectedAdvert)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {analyzerName(selectedAdvert)}
                      </a>
                    {:else}
                      {analyzerName(selectedAdvert)}
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
                        <th class="px-3 py-2 text-left font-medium">Analyzer</th>
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
                          <td class="whitespace-nowrap px-3 py-2">
                            {#if analyzerPacketUrl(obs)}
                              <a
                                class="text-accent2 hover:underline"
                                href={analyzerPacketUrl(obs)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {analyzerName(obs)}
                              </a>
                            {:else}
                              <span class="text-dim">{analyzerName(obs)}</span>
                            {/if}
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

    <Dialog.Root bind:open={publishDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          class="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(52rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-edge bg-bg shadow-2xl"
        >
          <div class="flex items-start justify-between gap-4 border-b border-edge px-4 py-3">
            <div class="min-w-0">
              <Dialog.Title class="text-base font-semibold">Map publish details</Dialog.Title>
              <Dialog.Description class="mt-1 text-xs text-muted truncate">
                {selectedPublish?.advName || '(unnamed)'} · captured {fmtAgo(selectedPublish?.firstCapturedAt || 0)}
              </Dialog.Description>
            </div>
            <Dialog.Close
              class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-dim hover:bg-elev hover:text-ink"
              aria-label="Close map publish details"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <div class="max-h-[calc(86vh-4rem)] overflow-auto px-4 py-4">
            {#if publishSummary.length}
              <dl class="grid gap-2 sm:grid-cols-3">
                {#each publishSummary as [label, value, sub]}
                  <div class="rounded-md bg-elev px-3 py-2">
                    <dt class="text-xs text-muted">{label}</dt>
                    <dd
                      class="mt-1 break-all text-sm"
                      class:font-mono={label !== 'Name' && label !== 'Type' && label !== 'Source'}
                    >
                      {value ?? '—'}
                    </dd>
                    {#if sub}<dd class="mt-0.5 text-xs text-dim">{sub}</dd>{/if}
                  </div>
                {/each}
                {#if selectedPublish?.link}
                  <div class="rounded-md bg-elev px-3 py-2 sm:col-span-3">
                    <dt class="text-xs text-muted">Map link</dt>
                    <dd class="mt-1 text-sm">
                      <a
                        class="text-accent2 hover:underline break-all"
                        href={selectedPublish.link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {selectedPublish.link}
                      </a>
                    </dd>
                  </div>
                {/if}
              </dl>
            {/if}

            {#if selectedPublishParams}
              <div class="mt-4">
                <div class="mb-1 text-xs text-muted">Params</div>
                <div class="shiki-json max-h-80 overflow-auto rounded-md bg-elev">
                  {#if highlightedPublishParams}
                    {@html highlightedPublishParams}
                  {:else}
                    <pre class="p-3 font-mono text-xs text-dim">{selectedPublishParams}</pre>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {/if}
</div>
{/if}

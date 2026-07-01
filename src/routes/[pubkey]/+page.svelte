<script>
  import { onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Dialog, Tooltip, Select } from 'bits-ui';
  import {
    ArrowDownLeft,
    ArrowUpRight,
    ChevronRight,
    ChevronDown,
    CircleQuestionMark,
    ShieldAlert,
    X
  } from '@lucide/svelte';
  import { MeshCoreDecoder, Utils } from '@michaelhart/meshcore-decoder';
  import {
    nodeDetail,
    nodeAdverts,
    nodeLinks,
    nodeNetworkStats,
    nodeAdvertActivity,
    nodeMapPublishes,
    meshNetworks,
    bands
  } from '$lib/api.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NodeMap from '$lib/NodeMap.svelte';
  import AddContactQR from '$lib/AddContactQR.svelte';
  import Flag from '$lib/Flag.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import { networkFlags, networkUrl } from '$lib/flags.js';
  import { TYPE_LABEL, fmtTime, fmtAgo, fmtCoords, shortKey, shortKey8, shortKeyWide } from '$lib/format.js';
  import { reverseGeocode, formatPlaceLabel, externalMapLinks } from '$lib/geocode.js';

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
  let bandCatalog = $state({}); // band id -> { name, range, region }, from bands.json
  bands().then((b) => (bandCatalog = b));
  let showAllLinks = $state(false);
  let neighborSort = $state('');
  let neighborSortDir = $state('asc');
  let heatmapWidth = $state(0);
  let heatmapHoveredDay = $state(null);
  let heatmapGridEl = $state(null);
  let heatmapResizeObserver;

  let place = $state(null);
  let placeLoading = $state(false);

  const locationSubtitle = $derived.by(() => {
    if (!node?.hasGps) return 'Location unknown';
    if (placeLoading) return '';
    return formatPlaceLabel(place);
  });

  const locationMapLinks = $derived(
    node?.hasGps ? externalMapLinks(node.lat, node.lon, { pubkey }) : []
  );

  const locationActionItems = $derived([
    { value: 'copy', label: 'Copy to clipboard' },
    ...locationMapLinks.map(({ value, label }) => ({ value, label }))
  ]);

  let locationMenuValue = $state('');
  let coordsCopied = $state(false);
  let coordsCopyTimer;

  function handleLocationAction(value) {
    if (!value || !node?.hasGps) return;
    if (value === 'copy') {
      navigator.clipboard?.writeText(fmtCoords(node.lat, node.lon)).then(() => {
        coordsCopied = true;
        clearTimeout(coordsCopyTimer);
        coordsCopyTimer = setTimeout(() => (coordsCopied = false), 1200);
      });
    } else {
      const link = locationMapLinks.find((l) => l.value === value);
      if (link) window.open(link.url, '_blank', 'noopener,noreferrer');
    }
    locationMenuValue = '';
  }

  $effect(() => {
    const pk = pubkey;
    const n = node;
    if (!n?.hasGps || !Number.isFinite(Number(n.lat)) || !Number.isFinite(Number(n.lon))) {
      place = null;
      placeLoading = false;
      return;
    }
    const lat = Number(n.lat);
    const lon = Number(n.lon);
    const ac = new AbortController();
    placeLoading = true;
    place = null;
    reverseGeocode(lat, lon, ac.signal)
      .then((p) => {
        if (pk !== pubkey) return;
        place = p;
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (pk === pubkey) place = null;
      })
      .finally(() => {
        if (pk === pubkey) placeLoading = false;
      });
    return () => ac.abort();
  });

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

  const MAX_REAL_LINK_KM = 500;
  const DEFAULT_ANALYZER_BASE = 'https://analyzer.meshcore.cz';

  function linkUnreal(link) {
    const dist = linkDistanceKm(link);
    return dist != null && dist > MAX_REAL_LINK_KM;
  }

  const mapLinks = $derived(links.filter((l) => !linkUnreal(l)));

  function fmtDistance(km) {
    if (km == null) return '—';
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  }

  function linkPackets(link, direction) {
    const key = direction === 'sent' ? 'sentByNode' : 'recvByNode';
    const fallback = direction === 'sent' ? 0 : link?.packetCount || 0;
    return Number.isFinite(Number(link?.[key])) ? Number(link[key]) : fallback;
  }

  function linkSnr(link, direction) {
    const key = direction === 'sent' ? 'lastSnrSentByNode' : 'lastSnrRecvByNode';
    if (Number.isFinite(Number(link?.[key]))) return Number(link[key]);
    const samples = direction === 'sent' ? link?.snrsSentByNode : link?.snrsRecvByNode;
    const latest = Array.isArray(samples) ? samples.findLast((v) => Number.isFinite(Number(v))) : null;
    return latest == null ? null : Number(latest);
  }

  function linkHash(link, direction) {
    return direction === 'sent' ? link?.lastHashSentByNode : link?.lastHashRecvByNode;
  }

  function linkAnalyzerBase(link) {
    for (const networkId of link?.networks ?? []) {
      const base = cleanUrl(catalog[networkId]?.analyzers?.[0]?.url);
      if (base) return base;
    }
    return DEFAULT_ANALYZER_BASE;
  }

  function linkPacketUrl(link, direction) {
    const hash = linkHash(link, direction);
    if (!hash) return '';
    return `${linkAnalyzerBase(link)}/#/packets/${encodeURIComponent(hash)}`;
  }

  function fmtSnr(snr) {
    if (snr == null) return '—';
    return `${Number.isInteger(snr) ? snr : snr.toFixed(1)} dB`;
  }

  function linkSnrSamples(link, direction) {
    const samples = direction === 'sent' ? link?.snrsSentByNode : link?.snrsRecvByNode;
    return Array.isArray(samples)
      ? samples.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : [];
  }

  function snrSamplesText(link, direction) {
    const samples = linkSnrSamples(link, direction);
    return samples.length ? samples.map(fmtSnr).join(', ') : '—';
  }

  function bestLinkSnr(link) {
    const sent = linkSnr(link, 'sent');
    const recv = linkSnr(link, 'recv');
    if (sent == null) return recv;
    if (recv == null) return sent;
    return Math.max(sent, recv);
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
    } else if (key === 'snr') {
      return compareNullableNumber(bestLinkSnr(a), bestLinkSnr(b), direction);
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

  function advertLocationKey(advert) {
    return advert?.hasGps ? fmtCoords(advert.lat, advert.lon) : '';
  }

  function advertObserverKey(advert) {
    return advert?.observerId || advert?.observerName || '';
  }

  function advertDiff(current, previous, currentGroup = null, previousGroup = null) {
    if (!previous) {
      return {
        received: false,
        hash: false,
        advertTime: false,
        name: false,
        type: false,
        location: false,
        network: false,
        analyzer: false,
        observer: false
      };
    }

    return {
      received: fmtAgo(current?.at) !== fmtAgo(previous?.at),
      hash: (currentGroup?.hash || current?.hash || '') !== (previousGroup?.hash || previous?.hash || ''),
      advertTime: (current?.advertTime || 0) !== (previous?.advertTime || 0),
      name: (current?.name || '') !== (previous?.name || ''),
      type: (current?.type ?? '') !== (previous?.type ?? ''),
      location: advertLocationKey(current) !== advertLocationKey(previous),
      network: (current?.networkId || '') !== (previous?.networkId || ''),
      analyzer: currentGroup
        ? analyzerGroupLabel(currentGroup) !== analyzerGroupLabel(previousGroup)
        : analyzerName(current) !== analyzerName(previous),
      observer: currentGroup
        ? observerLabel(currentGroup) !== observerLabel(previousGroup)
        : advertObserverKey(current) !== advertObserverKey(previous)
    };
  }

  function diffCellClass(changed, base = '') {
    return `${base} ${changed ? 'bg-accent/10 text-ink' : 'text-muted opacity-60'}`;
  }

  function diffValueClass(changed, base = '') {
    return `${base} ${changed ? 'text-ink' : 'text-muted opacity-60'}`;
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

  // Best-effort band id ("868", "915", …) for a frequency, by matching it into a
  // band's range from bands.json. Used only for the map fallback, where no band id
  // is supplied (networks declare their band explicitly).
  function inferBandKey(freqMhz) {
    if (freqMhz == null) return '';
    for (const [key, b] of Object.entries(bandCatalog)) {
      const m = (b?.range || '').match(/([\d.]+)\s*[–-]\s*([\d.]+)\s*(GHz|MHz)/i);
      if (!m) continue;
      let lo = parseFloat(m[1]);
      let hi = parseFloat(m[2]);
      if (/ghz/i.test(m[3])) {
        lo *= 1000;
        hi *= 1000;
      }
      if (freqMhz >= lo && freqMhz <= hi) return key;
    }
    return '';
  }

  // Radio (LoRa) settings. Primary source is the node's current (most-recently
  // active) network's declared radio config — the network is shown as the source.
  // map.meshcore.io params are only a fallback for nodes we don't observe live.
  const radio = $derived.by(() => {
    const net = netDetails[0] ?? null;
    const nr = net ? catalog[net.id]?.radio : null;
    if (nr && (nr.frequency_mhz != null || nr.bandwidth_khz != null || nr.spreading_factor != null)) {
      return {
        source: net.name,
        networkId: net.id,
        band: nr.frequency != null ? String(nr.frequency) : inferBandKey(nr.frequency_mhz),
        freq: nr.frequency_mhz,
        bw: nr.bandwidth_khz,
        sf: nr.spreading_factor,
        cr: nr.coding_rate ?? null,
        channel: nr.public_channel ?? ''
      };
    }
    for (const p of mapPublishes) {
      const params = p?.params;
      if (params && typeof params === 'object') {
        const { freq, bw, sf, cr } = params;
        if (freq != null || bw != null || sf != null || cr != null) {
          return {
            source: 'map.meshcore.io',
            band: inferBandKey(freq),
            freq,
            bw,
            sf,
            cr: cr != null ? `4/${cr}` : null,
            channel: ''
          };
        }
      }
    }
    return null;
  });

  const bandInfo = $derived(radio?.band ? (bandCatalog[radio.band] ?? null) : null);

  function fmtCodingRate(cr) {
    if (cr == null || cr === '') return '—';
    const s = String(cr);
    const m = s.match(/^4\/(\d+)$/);
    return m ? m[1] : s;
  }

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

  const regionNames =
    typeof Intl !== 'undefined' && Intl.DisplayNames
      ? new Intl.DisplayNames(['en'], { type: 'region' })
      : null;

  function networkRadios(network) {
    return Array.isArray(network?.radios) ? network.radios : network?.radio ? [network.radio] : [];
  }

  function countryLabel(code) {
    const upper = String(code || '').toUpperCase();
    return regionNames?.of(upper) || upper;
  }

  function networkCoverageLabel(countries) {
    if (!countries?.length) return 'Unspecified coverage';
    return countries.map((code) => countryLabel(code)).join(', ');
  }

  function networkRadioSummary(radio) {
    if (!radio) return 'No radio preset in catalog';
    const parts = [];
    if (radio.frequency_mhz != null) parts.push(`${radio.frequency_mhz} MHz`);
    if (radio.bandwidth_khz != null) parts.push(`${radio.bandwidth_khz} kHz`);
    if (radio.spreading_factor != null) parts.push(`SF${radio.spreading_factor}`);
    if (radio.coding_rate != null) parts.push(`CR ${fmtCodingRate(radio.coding_rate)}`);
    return parts.join(' · ') || 'Radio preset listed';
  }

  // Each network the node was heard on, enriched from the catalog (flags) and the
  // per-network advert stats (count + last advert). Most-recently-active first.
  const netDetails = $derived(
    (node?.networks ?? [])
      .map((id) => {
        const c = catalog[id] || {};
        const s = netStats[id] || {};
        const radios = networkRadios(c);
        const primaryRadio = radios[0] || null;
        const countries = c.coverage?.countries ?? [];
        const band = primaryRadio?.frequency != null ? bandCatalog[String(primaryRadio.frequency)] : null;
        return {
          id,
          name: c.name || id,
          description: c.description || '',
          flags: networkFlags(c),
          countries,
          coverage: networkCoverageLabel(countries),
          analyzers: c.analyzers ?? [],
          radios,
          radio: primaryRadio,
          radioSummary: networkRadioSummary(primaryRadio),
          channel: primaryRadio?.public_channel ?? '',
          appPreset: radios.some((r) => r?.app_preset),
          band,
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
    {#snippet placeLoadingSkeleton()}
      <span class="inline-flex items-center gap-1.5" role="status" aria-label="Loading location">
        <span class="h-3 w-4 shrink-0 animate-pulse rounded-sm bg-edge"></span>
        <span class="h-3 w-24 animate-pulse rounded bg-edge sm:w-32"></span>
      </span>
    {/snippet}
    {#snippet helpTip(text, kind = '', href = '', linkText = 'Learn more')}
      <Tooltip.Root>
        <Tooltip.Trigger
          class="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-muted outline-none hover:text-accent focus-visible:text-accent focus-visible:ring-1 focus-visible:ring-accent"
          aria-label="More information"
        >
          <CircleQuestionMark size={13} aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            class="z-50 max-w-72 rounded-md border border-edge bg-elev2 px-3 py-2 text-xs leading-relaxed text-ink shadow-lg shadow-black/30"
          >
            {#if kind}
              <div class="mb-2 rounded-md border border-edge/80 bg-bg/70 px-2 py-2">
                {#if kind === 'frequency'}
                  <div class="flex h-8 items-center gap-1">
                    {#each [1, 2, 3, 4, 5, 6, 7] as n}
                      <span
                        class="block w-4 rounded-full bg-accent/80"
                        style={`height:${[10, 18, 26, 18, 10, 18, 26][n - 1]}px`}
                      ></span>
                    {/each}
                  </div>
                  <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">same channel center</div>
                {:else if kind === 'bandwidth'}
                  <div class="flex h-8 items-end gap-1">
                    <span class="h-2 w-5 rounded-sm bg-accent2/35"></span>
                    <span class="h-4 w-9 rounded-sm bg-accent2/70"></span>
                    <span class="h-6 w-14 rounded-sm bg-accent"></span>
                  </div>
                  <div class="mt-1 flex justify-between text-[10px] text-muted">
                    <span>narrow</span><span>wider</span>
                  </div>
                {:else if kind === 'spreading'}
                  <div class="grid grid-cols-3 gap-1 text-center text-[10px]">
                    <span class="rounded bg-accent/15 px-1 py-1 text-accent">SF7<br />fast</span>
                    <span class="rounded bg-accent/25 px-1 py-1 text-accent">SF9<br />mid</span>
                    <span class="rounded bg-accent/40 px-1 py-1 text-accent">SF12<br />far</span>
                  </div>
                {:else if kind === 'coding'}
                  <div class="flex items-center gap-1">
                    <span class="h-4 w-6 rounded-sm bg-accent"></span>
                    <span class="h-4 w-2 rounded-sm bg-warn"></span>
                    <span class="h-4 w-2 rounded-sm bg-warn"></span>
                    <span class="text-[10px] text-muted">data + repair bits</span>
                  </div>
                  <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">MeshCore shows one number</div>
                {:else if kind === 'activity'}
                  <div class="grid w-max grid-cols-7 gap-1">
                    {#each [0, 1, 2, 0, 3, 4, 1, 0, 2, 4, 3, 0, 1, 4] as level}
                      <span class={`h-2.5 w-2.5 rounded-[2px] ${heatmapColor(level)}`}></span>
                    {/each}
                  </div>
                  <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">days with adverts</div>
                {:else if kind === 'links'}
                  <div class="flex items-center justify-center gap-1.5">
                    <span class="h-3 w-3 rounded-full bg-accent"></span>
                    <span class="h-px w-8 bg-edge"></span>
                    <span class="h-3 w-3 rounded-full bg-accent2"></span>
                    <span class="h-px w-8 bg-edge"></span>
                    <span class="h-3 w-3 rounded-full bg-warn"></span>
                  </div>
                  <div class="mt-1 text-center text-[10px] uppercase tracking-wide text-muted">observed relationships</div>
                {:else if kind === 'history'}
                  <div class="space-y-1">
                    <div class="h-2 w-20 rounded bg-accent/75"></div>
                    <div class="h-2 w-28 rounded bg-accent2/60"></div>
                    <div class="h-2 w-16 rounded bg-warn/65"></div>
                  </div>
                  <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">newest first timeline</div>
                {:else if kind === 'hash'}
                  <div class="flex items-center gap-1">
                    <span class="rounded bg-accent/20 px-1.5 py-1 font-mono text-[10px] text-accent">a1b2</span>
                    <span class="text-muted">=</span>
                    <span class="h-2 w-2 rounded-full bg-accent2"></span>
                    <span class="h-2 w-2 rounded-full bg-accent2"></span>
                    <span class="h-2 w-2 rounded-full bg-accent2"></span>
                  </div>
                  <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">same payload, many observers</div>
                {/if}
              </div>
            {/if}
            {text}
            {#if href}
              <a
                class="mt-2 block text-accent2 hover:underline"
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                {linkText} ↗
              </a>
            {/if}
            <Tooltip.Arrow class="text-edge" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    {/snippet}
    {#snippet labelHelp(label, help, kind = '', href = '', linkText = 'Learn more')}
      <span class="inline-flex items-center gap-1">
        <span>{label}</span>
        {@render helpTip(help, kind, href, linkText)}
      </span>
    {/snippet}
    {#snippet sectionTitle(label, help, kind = '', href = '', linkText = 'Learn more')}
      <h2 class="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        <span>{label}</span>
        {@render helpTip(help, kind, href, linkText)}
      </h2>
    {/snippet}
    {#snippet directionIcon(direction)}
      {#if direction === 'sent'}
        <ArrowUpRight size={13} aria-hidden="true" class="text-accent2" />
      {:else}
        <ArrowDownLeft size={13} aria-hidden="true" class="text-accent" />
      {/if}
    {/snippet}
    {#snippet linkMetricTooltip(kind, link)}
      <Tooltip.Root>
        <Tooltip.Trigger
          class="inline-flex flex-col items-end gap-1 outline-none hover:text-ink focus-visible:text-ink focus-visible:ring-1 focus-visible:ring-accent"
          onclick={(event) => event.stopPropagation()}
        >
          <span class="inline-flex items-center justify-end gap-1">
            {@render directionIcon('sent')}
            {#if kind === 'packets'}
              {linkPackets(link, 'sent').toLocaleString()}
            {:else}
              {fmtSnr(linkSnr(link, 'sent'))}
            {/if}
          </span>
          <span class="inline-flex items-center justify-end gap-1 text-muted">
            {@render directionIcon('recv')}
            {#if kind === 'packets'}
              {linkPackets(link, 'recv').toLocaleString()}
            {:else}
              {fmtSnr(linkSnr(link, 'recv'))}
            {/if}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            class="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-edge bg-elev2 px-3 py-3 text-xs leading-relaxed text-ink shadow-lg shadow-black/30"
          >
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {kind === 'packets' ? 'Packets by direction' : 'SNR by direction'}
            </div>
            <table class="w-full border-separate border-spacing-0">
              <thead class="text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th class="pb-1 text-left font-medium">Direction</th>
                  <th class="pb-1 text-right font-medium">{kind === 'packets' ? 'Count' : 'Latest'}</th>
                  <th class="pb-1 pl-3 text-left font-medium">{kind === 'packets' ? 'Last packet' : 'Samples'}</th>
                </tr>
              </thead>
              <tbody class="align-top font-mono">
                <tr class="border-t border-edge/70">
                  <td class="border-t border-edge/70 py-1.5 pr-3 font-sans text-ink">
                    <span class="inline-flex items-center gap-1.5">
                      {@render directionIcon('sent')}
                      Outbound
                    </span>
                  </td>
                  <td class="border-t border-edge/70 py-1.5 text-right">
                    {#if kind === 'packets'}
                      {linkPackets(link, 'sent').toLocaleString()}
                    {:else}
                      {fmtSnr(linkSnr(link, 'sent'))}
                    {/if}
                  </td>
                  <td class="border-t border-edge/70 py-1.5 pl-3 text-muted break-all">
                    {#if kind === 'packets'}
                      {#if linkPacketUrl(link, 'sent')}
                        <a
                          class="text-accent2 hover:underline"
                          href={linkPacketUrl(link, 'sent')}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {linkHash(link, 'sent')}
                        </a>
                      {:else}
                        —
                      {/if}
                    {:else}
                      {snrSamplesText(link, 'sent')}
                    {/if}
                  </td>
                </tr>
                <tr>
                  <td class="border-t border-edge/70 py-1.5 pr-3 font-sans text-ink">
                    <span class="inline-flex items-center gap-1.5">
                      {@render directionIcon('recv')}
                      Inbound
                    </span>
                  </td>
                  <td class="border-t border-edge/70 py-1.5 text-right">
                    {#if kind === 'packets'}
                      {linkPackets(link, 'recv').toLocaleString()}
                    {:else}
                      {fmtSnr(linkSnr(link, 'recv'))}
                    {/if}
                  </td>
                  <td class="border-t border-edge/70 py-1.5 pl-3 text-muted break-all">
                    {#if kind === 'packets'}
                      {#if linkPacketUrl(link, 'recv')}
                        <a
                          class="text-accent2 hover:underline"
                          href={linkPacketUrl(link, 'recv')}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {linkHash(link, 'recv')}
                        </a>
                      {:else}
                        —
                      {/if}
                    {:else}
                      {snrSamplesText(link, 'recv')}
                    {/if}
                  </td>
                </tr>
              </tbody>
            </table>
            <Tooltip.Arrow class="text-edge" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    {/snippet}
    {#snippet badgeTip(help, kind = '', href = '', linkText = 'Learn more', side = 'top')}
      <Tooltip.Portal>
        <Tooltip.Content
          {side}
          sideOffset={6}
          class="z-50 max-w-72 rounded-md border border-edge bg-elev2 px-3 py-2 text-xs leading-relaxed text-ink shadow-lg shadow-black/30"
        >
          {#if kind}
            <div class="mb-2 rounded-md border border-edge/80 bg-bg/70 px-2 py-2">
              {#if kind === 'identity'}
                <div class="flex items-center gap-1.5">
                  <span class="grid h-6 w-6 place-items-center rounded bg-accent/15 text-accent">
                    <NodeIcon type={node.type} size={14} />
                  </span>
                  <span class="h-px w-10 bg-edge"></span>
                  <span class="rounded bg-accent2/15 px-1.5 py-1 text-[10px] text-accent2">role</span>
                </div>
              {:else if kind === 'freshness'}
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full bg-ok"></span>
                  <span class="h-2.5 w-2.5 rounded-full bg-warn"></span>
                  <span class="h-2.5 w-2.5 rounded-full bg-muted"></span>
                  <span class="text-[10px] text-muted">recent to old</span>
                </div>
              {:else if kind === 'unsigned'}
                <div class="flex items-center gap-1.5">
                  <ShieldAlert size={14} class="text-warn" />
                  <span class="h-px w-8 bg-edge"></span>
                  <span class="rounded bg-warn/15 px-1.5 py-1 text-[10px] text-warn">not signed here</span>
                </div>
              {/if}
            </div>
          {/if}
          {help}
          {#if href}
            <a
              class="mt-2 block text-accent2 hover:underline"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {linkText} ↗
            </a>
          {/if}
          <Tooltip.Arrow class="text-edge" />
        </Tooltip.Content>
      </Tooltip.Portal>
    {/snippet}
    {#snippet networkInfoTip(n)}
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={8}
          class="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-edge bg-elev2 px-3 py-3 text-xs leading-relaxed text-ink shadow-lg shadow-black/30"
        >
          <div class="mb-2 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                {#if n.flags.length}
                  <span class="flex shrink-0 items-center gap-1">
                    {#each n.flags as f (f.code)}<Flag code={f.code} class="h-3 w-5" />{/each}
                  </span>
                {/if}
                <div class="truncate font-semibold text-ink">{n.name}</div>
              </div>
              <div class="mt-0.5 font-mono text-[10px] text-muted">{n.id}</div>
            </div>
            {#if n.appPreset}
              <span class="shrink-0 rounded border border-accent2/30 bg-accent2/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">
                app preset
              </span>
            {/if}
          </div>

          {#if n.description}
            <p class="mb-2 text-dim">{n.description}</p>
          {/if}

          <div class="mb-2 rounded-md border border-edge/80 bg-bg/70 px-2 py-2">
            <div class="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted">
              <span>Radio</span>
              {#if n.band}
                <span
                  class="rounded border px-1.5 py-0.5 normal-case"
                  style={n.band.color
                    ? `color:${n.band.color};border-color:${n.band.color}66;background-color:${n.band.color}1f`
                    : ''}
                >
                  {n.band.region || `${n.radio?.frequency ?? ''} MHz`}
                </span>
              {/if}
            </div>
            <div class="font-mono text-[11px] text-ink">{n.radioSummary}</div>
            {#if n.channel}
              <div class="mt-1 text-[11px] text-muted">
                public channel <span class="font-mono text-dim">{n.channel}</span>
              </div>
            {/if}
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="rounded bg-bg/70 px-2 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-muted">Coverage</div>
              <div class="mt-0.5 truncate" title={n.coverage}>{n.coverage}</div>
            </div>
            <div class="rounded bg-bg/70 px-2 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-muted">Analyzers</div>
              <div class="mt-0.5">{n.analyzers.length || '—'}</div>
            </div>
            <div class="rounded bg-bg/70 px-2 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-muted">Node adverts</div>
              <div class="mt-0.5">{n.adverts ? n.adverts.toLocaleString() : '—'}</div>
            </div>
            <div class="rounded bg-bg/70 px-2 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-muted">Last seen here</div>
              <div class="mt-0.5" title={n.lastAt ? fmtTime(n.lastAt) : ''}>{n.lastAt ? fmtAgo(n.lastAt) : '—'}</div>
            </div>
          </div>

          <div class="mt-2 text-[11px] text-muted">Click to open this network in the MeshCore catalog.</div>
          <Tooltip.Arrow class="text-edge" />
        </Tooltip.Content>
      </Tooltip.Portal>
    {/snippet}
    <!-- Top: identity + overview + extras (left), map + add-to-app (top-right) -->
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
    <div class="mt-4 grid gap-6 lg:grid-cols-3 items-start">
      <!-- Map + QR: below main content on mobile, sticky sidebar on desktop -->
      <aside class="order-2 space-y-6 lg:order-2 lg:sticky lg:top-6">
        {#if radio}
          <section>
            <div class="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              {@render sectionTitle('LoRa Radio', 'Radio settings used by this node or by the network it was heard on. Matching these values matters for devices to exchange packets.', 'frequency', 'https://www.semtech.com/design-support/faq/faq-lora', 'LoRa FAQ')}
              <div class="flex items-center gap-1.5 text-[11px] text-muted">
                {@render labelHelp('Source:', 'Where these radio parameters came from. Network values are observed from the directory catalog; map entries are mirrored from map.meshcore.io.')}
                {#if radio.networkId}
                  <a
                    href={networkUrl(radio.networkId)}
                    target="_blank"
                    rel="noreferrer"
                    class="inline-flex hover:opacity-80"
                  >
                    <NetworkPill id={radio.networkId} {catalog} />
                  </a>
                  <span>network</span>
                {:else}
                  <span class="inline-flex items-center rounded bg-elev2 px-1.5 py-0.5 text-[10px] leading-none text-dim">
                    map.meshcore.io
                  </span>
                {/if}
              </div>
            </div>
            <div class="rounded-xl border border-edge bg-elev p-3">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="text-xs text-muted">{@render labelHelp('Band', 'Regional LoRa band group. It summarizes the legal frequency range and common MeshCore preset for this node.', 'bandwidth', 'https://meshcore.ninja/bands', 'MeshCore bands')}</span>
                <a
                  href="https://meshcore.ninja/bands"
                  target="_blank"
                  rel="noreferrer"
                  class="rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors"
                  style={bandInfo?.color
                    ? `color:${bandInfo.color};border-color:${bandInfo.color}66;background-color:${bandInfo.color}1f`
                    : 'color:var(--color-accent);border-color:color-mix(in srgb,var(--color-accent) 40%,transparent);background-color:color-mix(in srgb,var(--color-accent) 10%,transparent)'}
                  title={bandInfo
                    ? `${bandInfo.range} · ${bandInfo.region}${bandInfo.color ? ` · band colour ${bandInfo.color}` : ''}`
                    : 'View band reference'}
                >
                  {bandInfo?.region || (radio.band ? `${radio.band} MHz` : 'Unknown')}
                </a>
                {#if bandInfo?.name}
                  <span class="text-[11px] text-dim">{bandInfo.name}</span>
                {/if}
              </div>
              <div class="grid grid-cols-2 gap-2">
                {#snippet radioStat(label, value, help, kind = '', href = '', linkText = 'Learn more')}
                  <div class="rounded-lg bg-bg px-3 py-2">
                    <div class="text-xs text-muted">{@render labelHelp(label, help, kind, href, linkText)}</div>
                    <div class="mt-0.5 font-mono text-sm font-semibold">{value}</div>
                  </div>
                {/snippet}
                {@render radioStat('Frequency', radio.freq != null ? `${radio.freq} MHz` : '—', 'Center frequency used for the LoRa channel, in MHz. Radios must be on the same frequency to hear each other.', 'frequency')}
                {@render radioStat('Bandwidth', radio.bw != null ? `${radio.bw} kHz` : '—', 'LoRa channel width. Narrower bandwidth usually improves sensitivity but sends data more slowly.', 'bandwidth', 'https://www.semtech.com/design-support/faq/faq-lora', 'LoRa FAQ')}
                {@render radioStat('Spreading', radio.sf != null ? `SF${radio.sf}` : '—', 'LoRa spreading factor. Higher SF reaches farther at the cost of slower airtime; lower SF is faster but needs a stronger signal.', 'spreading', 'https://www.thethingsnetwork.org/docs/lorawan/spreading-factors/', 'Spreading factors')}
                {@render radioStat('Coding rate', fmtCodingRate(radio.cr), 'Forward error correction setting. MeshCore usually shows this as a single number; larger values mean less redundancy and shorter airtime, while smaller values add more repair data.', 'coding', 'https://www.semtech.com/design-support/faq/faq-lora', 'LoRa FAQ')}
              </div>
              {#if radio.channel}
                <div class="mt-2 flex items-center gap-2 text-xs">
                  <span class="text-muted">{@render labelHelp('Public channel', 'MeshCore channel name embedded in the network preset. Devices generally need the same channel and radio settings to participate.', '', 'https://github.com/meshcore-dev/MeshCore', 'MeshCore project')}</span>
                  <span class="font-mono text-dim">{radio.channel}</span>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <section>
          <div class="mb-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            {@render sectionTitle('Location', 'Coordinates advertised by the node or mirrored from the map directory. Neighbor lines are shown only for linked nodes that also publish coordinates.')}
            <div class="flex flex-col items-start gap-0.5 sm:items-end">
              {#if node.hasGps}
                <Select.Root
                  type="single"
                  bind:value={locationMenuValue}
                  onValueChange={handleLocationAction}
                  items={locationActionItems}
                  allowDeselect
                >
                  <Select.Trigger
                    aria-label="Location actions"
                    class="flex cursor-pointer flex-col items-start gap-0.5 rounded border-0 bg-transparent p-0 text-left outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-edge sm:items-end sm:text-right"
                  >
                    {#if locationSubtitle}
                      <span class="inline-flex items-center gap-1.5 text-xs text-dim">
                        {#if place?.countryCode}
                          <Flag code={place.countryCode} class="h-3 w-4" />
                        {/if}
                        {locationSubtitle}
                      </span>
                    {:else if placeLoading}
                      {@render placeLoadingSkeleton()}
                    {/if}
                    <span class="inline-flex items-center gap-1 font-mono text-xs text-dim break-all sm:break-normal sm:whitespace-nowrap">
                      {#if coordsCopied}
                        <span class="font-sans text-accent">Copied</span>
                      {:else}
                        {fmtCoords(node.lat, node.lon)}
                      {/if}
                      <ChevronDown class="size-3 shrink-0 text-muted" />
                    </span>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      side="bottom"
                      align="end"
                      sideOffset={6}
                      class="z-50 min-w-[12rem] overflow-y-auto rounded-lg border border-edge bg-elev2 p-1 text-xs text-ink shadow-lg shadow-black/30 outline-none"
                    >
                      <Select.Viewport>
                        <Select.Item
                          value="copy"
                          label="Copy to clipboard"
                          class="flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent/15 data-[highlighted]:text-accent"
                        >
                          {#snippet children()}
                            <span>Copy to clipboard</span>
                          {/snippet}
                        </Select.Item>
                        {#if locationMapLinks.length}
                          <div class="my-1 h-px bg-edge" role="separator"></div>
                          <Select.Group>
                            <Select.GroupHeading
                              class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted"
                            >
                              Open in
                            </Select.GroupHeading>
                            {#each locationMapLinks as link (link.value)}
                              <Select.Item
                                value={link.value}
                                label={link.label}
                                class="flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent/15 data-[highlighted]:text-accent"
                              >
                                {#snippet children()}
                                  <span>{link.label} ↗</span>
                                {/snippet}
                              </Select.Item>
                            {/each}
                          </Select.Group>
                        {/if}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              {:else}
                <span class="text-xs text-dim">Location unknown</span>
              {/if}
            </div>
          </div>
          <NodeMap lat={node.lat} lon={node.lon} hasGps={node.hasGps} links={mapLinks} />
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
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="rounded-full border border-edge px-2 py-0.5 capitalize outline-none hover:border-accent/60 hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    {TYPE_LABEL[node.type] ?? 'unknown'}
                  </Tooltip.Trigger>
                  {@render badgeTip('Advertised MeshCore node role. Repeaters relay mesh traffic; companions are user devices; rooms and sensors expose specialized endpoints.', 'identity', 'https://github.com/meshcore-dev/MeshCore', 'MeshCore project')}
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 outline-none hover:bg-elev2 hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    <span class="h-2 w-2 rounded-full {freshColor}"></span>
                    {mapOnly ? 'Last map publish' : 'Last heard'} {fmtAgo(lastHeard)}
                  </Tooltip.Trigger>
                  {@render badgeTip(mapOnly ? 'This is the newest captured map-directory update. It is not the same as a signed advert captured by our analyzers.' : 'Newest activity we know about for this node: either a signed advert or a neighbor link involving it.', 'freshness')}
                </Tooltip.Root>
                {#if locationSubtitle}
                  <span class="ml-1 inline-flex items-center gap-1.5 sm:ml-1.5">
                    {#if place?.countryCode}
                      <Flag code={place.countryCode} class="h-3 w-4" />
                    {/if}
                    {locationSubtitle}
                  </span>
                {:else if placeLoading}
                  <span class="ml-1 sm:ml-1.5">
                    {@render placeLoadingSkeleton()}
                  </span>
                {/if}
                {#if mapOnly}
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      class="inline-flex items-center gap-1 rounded-full border border-warn/45 bg-warn/10 px-2 py-0.5 text-warn outline-none hover:border-warn/70 hover:bg-warn/15 focus-visible:ring-1 focus-visible:ring-warn"
                    >
                      <ShieldAlert size={13} aria-hidden="true" />
                      Unsigned map entry
                    </Tooltip.Trigger>
                    {@render badgeTip('Mirrored from map.meshcore.io, but this site has not captured a signed advert for the node yet. Treat identity, location, and radio details as directory data until a signed advert appears.', 'unsigned', 'https://map.meshcore.io', 'Open map directory')}
                  </Tooltip.Root>
                {/if}
              </div>
            </div>
          </div>

          <!-- Public key -->
          <div class="mt-5">
            <div class="text-[10px] uppercase tracking-wide text-muted mb-1">{@render labelHelp('Public key', 'The node identity key. This is the stable address used to link adverts, neighbors, map publishes, and the QR contact payload.', '', 'https://github.com/meshcore-dev/MeshCore', 'MeshCore project')}</div>
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
          <div class="flex items-start gap-3 rounded-xl border border-warn/35 bg-warn/10 px-4 py-3 text-sm text-dim">
            <ShieldAlert size={18} class="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <p>
              <span class="font-medium text-ink">Unsigned map entry.</span>
              We have not captured a signed advert for this node yet, so the details below are
              mirrored from the
              <a href={MAP_SITE} target="_blank" rel="noreferrer" class="text-accent2 hover:underline">map.meshcore.io</a>
              directory. See <a href="#map-publishes" class="text-accent2 hover:underline">Map publishes</a> for the captured snapshots.
            </p>
          </div>
        {/if}

        <!-- Overview -->
        <section>
          <div class="mb-2">
            {@render sectionTitle('Overview', 'A compact summary of when this node appeared, how recently it was active, and how much supporting data we have for it.', 'history')}
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {#snippet stat(label, value, sub, help, kind = '', href = '', linkText = 'Learn more')}
              <div class="rounded-lg bg-elev px-3 py-2.5">
                <div class="text-xs text-muted">{@render labelHelp(label, help, kind, href, linkText)}</div>
                <div class="text-base font-semibold mt-1 truncate" title={value}>{value}</div>
                {#if sub}<div class="text-xs text-dim mt-0.5">{sub}</div>{/if}
              </div>
            {/snippet}
            {#if mapOnly}
              {@const mapAdvert = sane(node.lastAdvertAt || 0)}
              {@render stat('First captured', fmtAgo(firstCaptured), fmtTime(firstCaptured), 'When this map-directory entry first appeared in our captured snapshots. This is not a signed advert observation.')}
              {@render stat('Last map publish', fmtAgo(lastHeard), 'from directory', 'Most recent update time for the mirrored map.meshcore.io entry.')}
              {@render stat('Last advert', mapAdvert ? fmtAgo(mapAdvert) : '—', mapAdvert ? `${fmtTime(mapAdvert)} · per map` : 'unknown', 'Advert timestamp reported by the map directory. For unsigned map entries this has not been verified by our analyzers.')}
              {@render stat('Publishes', mapPublishes.length ? String(mapPublishes.length) : '—', 'captured', 'How many distinct map-directory snapshots we have stored for this node.')}
              {@render stat('Location', node.hasGps ? fmtCoords(node.lat, node.lon) : '—', node.hasGps ? 'from map' : 'no coordinates', 'Coordinates mirrored from the map entry, when available.')}
            {:else}
              {@render stat('First seen', fmtAgo(node.firstAdvertAt), fmtTime(node.firstAdvertAt), 'Earliest signed advert we have captured for this public key.')}
              {@render stat('Last heard', fmtAgo(lastHeard), 'advert or link', 'Newest activity we know about: either a signed advert from this node or a neighbor link involving it.')}
              {@render stat('Last advert', fmtAgo(node.lastAdvertAt), fmtTime(node.lastAdvertAt), 'Most recent signed advert captured for this node. Adverts carry identity, type, location, and network metadata.')}
              {@render stat('Adverts', node.advertCount.toLocaleString(), 'observed total', 'Total signed advert observations captured across analyzers and networks. Repeated observations of the same content may be grouped in the history table.', 'hash', 'https://github.com/meshcore-dev/MeshCore', 'MeshCore project')}
              {@render stat('Networks', String((node.networks ?? []).length), 'heard on', 'Number of network catalogs where this node has been observed.')}
              {@render stat('Links', linksTotal ? linksTotal.toLocaleString() : '—', 'neighbours', 'Neighbor relationships reported by analyzers. A link means packets suggest these nodes can hear or route near each other; distance is only shown when both have coordinates.', 'links')}
            {/if}
          </div>
        </section>

        <!-- Networks (enriched from the catalog) -->
        {#if netDetails.length}
          <section>
            <div class="mb-2">
            {@render sectionTitle('Networks', 'Networks where this node was observed. The number in parentheses is the captured advert count for that network.', 'links')}
            </div>
            <div class="grid sm:grid-cols-2 gap-3">
              {#each netDetails as n}
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    {#snippet child({ props })}
                      <a
                        {...props}
                        href={networkUrl(n.id)}
                        target="_blank"
                        rel="noreferrer"
                        class="group flex flex-col gap-1 rounded-lg bg-elev px-3 py-2 outline-none transition-colors hover:bg-elev2 focus-visible:ring-1 focus-visible:ring-accent sm:flex-row sm:items-center sm:gap-2.5"
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
                          {#if n.appPreset}
                            <span class="hidden rounded border border-accent2/30 bg-accent2/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent2 sm:inline">
                              preset
                            </span>
                          {/if}
                        </span>
                        {#if n.lastAt}
                          <span class="text-xs text-dim sm:shrink-0 sm:whitespace-nowrap sm:text-right" title={fmtTime(n.lastAt)}>
                            {fmtAgo(n.lastAt)} ({n.adverts.toLocaleString()})
                          </span>
                        {/if}
                      </a>
                    {/snippet}
                  </Tooltip.Trigger>
                  {@render networkInfoTip(n)}
                </Tooltip.Root>
              {/each}
            </div>
          </section>
        {/if}

        <section>
          <div class="mb-2 flex items-baseline justify-between gap-3">
            {@render sectionTitle('Advert activity', 'Daily activity from captured signed adverts. Brighter cells mean more adverts were observed on that day.', 'activity')}
            <span class="text-xs text-muted">{@render labelHelp(`last ${visibleHeatmapDayCount()} days`, 'The visible range adapts to the card width. Hover or focus a square to see the exact day and advert count.', 'activity')}</span>
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
                                class={`block h-3 w-3 rounded-[2px] border ${heatmapCellHovered(day) ? 'border-ink shadow-[0_0_0_1px_var(--color-accent)]' : 'border-transparent'} ${heatmapColor(heatmapLevel(day.adverts))}`}
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
                                <Tooltip.Arrow class="text-edge" />
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
              {@render sectionTitle('Neighbors', 'Nodes linked to this node by observed packet activity. The table is evidence of connectivity, not a guaranteed live route right now.', 'links')}
              <span class="text-xs text-muted">{@render labelHelp(`${linksTotal} link${linksTotal === 1 ? '' : 's'}`, 'Total neighbor links known by the API. The table shows the most relevant rows unless you expand or sort it.', 'links')}</span>
            </div>
            <div class="overflow-x-auto rounded-xl border border-edge">
              <table class="w-full text-sm">
                <thead class="bg-elev2 text-muted text-xs">
                  <tr>
                    <th class="text-left font-medium px-3 py-2">
                      <span class="inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('name')}>
                          Neighbour{sortMark('name')}
                        </button>
                        {@render helpTip('The linked node name and type. Click a row to open that node profile.', 'links')}
                      </span>
                    </th>
                    <th class="text-left font-medium px-3 py-2">
                      <span class="inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('pubkey')}>
                          Public key{sortMark('pubkey')}
                        </button>
                        {@render helpTip('Short form of the linked node public key.')}
                      </span>
                    </th>
                    <th class="text-right font-medium px-3 py-2">
                      <span class="ml-auto inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('distance')}>
                          Distance{sortMark('distance')}
                        </button>
                        {@render helpTip(`Straight-line distance between advertised coordinates. Values over ${MAX_REAL_LINK_KM} km are marked unreal because they are unlikely to be direct radio links.`, 'links')}
                      </span>
                    </th>
                    <th class="text-right font-medium px-3 py-2">
                      <span class="ml-auto inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('packets')}>
                          Packets{sortMark('packets')}
                        </button>
                        {@render helpTip('Directional packet counts: outbound packets sent by this node and inbound packets received from the neighbor.', 'activity')}
                      </span>
                    </th>
                    <th class="text-right font-medium px-3 py-2">
                      <span class="ml-auto inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('snr')}>
                          SNR{sortMark('snr')}
                        </button>
                        {@render helpTip('Latest signal-to-noise ratio per direction when the API has SNR samples for this link.', 'activity')}
                      </span>
                    </th>
                    <th class="text-left font-medium px-3 py-2">
                      <span class="inline-flex items-center gap-1">
                        <button class="hover:text-ink" onclick={() => sortNeighbors('last')}>
                          Last heard{sortMark('last')}
                        </button>
                        {@render helpTip('Most recent time this neighbor relationship was observed.')}
                      </span>
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
                        {#if linkUnreal(l)}
                          <span
                            class="text-warn"
                            title="{fmtDistance(dist)} — over {MAX_REAL_LINK_KM} km, likely not a real radio link"
                          >unreal</span>
                        {:else if dist != null}
                          <span class="font-mono">{fmtDistance(dist)}</span>
                        {:else}
                          <span class="text-muted" title={distanceUnavailableReason(l)}>No coordinates</span>
                        {/if}
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap text-right font-mono text-xs">
                        {@render linkMetricTooltip('packets', l)}
                      </td>
                      <td class="px-3 py-2 whitespace-nowrap text-right font-mono text-xs">
                        {@render linkMetricTooltip('snr', l)}
                      </td>
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
            <div class="mb-2">
            {@render sectionTitle('Identity history', 'Previous names, types, or locations seen in older adverts. This helps spot renames, moves, or reconfigured devices.', 'history')}
            </div>
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
        {@render sectionTitle('Advert history', 'Signed adverts captured for this public key, newest first. Changed fields are softly highlighted; repeated values are dimmed so profile changes stand out.', 'history', 'https://github.com/meshcore-dev/MeshCore', 'MeshCore project')}
        <span class="text-xs text-muted">{@render labelHelp(`${adverts.length} loaded${hasMore ? '+' : ''}`, 'Rows are loaded in pages. A plus means older adverts are available with the load button below.', 'history')}</span>
      </div>
      <div class="overflow-x-auto rounded-xl border border-edge">
        <table class="w-full text-sm">
          <thead class="bg-elev2 text-muted text-xs">
            <tr>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Received', 'When one of our analyzers received this advert packet.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Content hash', 'Hash of the advert payload. Identical content observed by multiple analyzers is grouped under the same hash.', 'hash')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Advert time', 'Timestamp encoded in the advert itself, when available. This can differ from when the analyzer received it.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Name', 'Node name advertised in this packet.')}</th>
              <th class="text-left font-medium px-3 py-2 w-12">{@render labelHelp('Type', 'MeshCore node role advertised in this packet, such as repeater, companion, room, or sensor.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Location', 'Coordinates carried by the advert, if the node published GPS data.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Network', 'Network catalog context where the advert was observed.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Analyzer', 'Analyzer instance that captured or reported this packet. Links open the packet in the analyzer when available.')}</th>
              <th class="text-left font-medium px-3 py-2">{@render labelHelp('Observer', 'Specific observer device or station behind the analyzer, when provided.')}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-edge">
            {#each advertGroups as group, groupIndex (group.key)}
              {@const a = group.first}
              {@const prevGroup = advertGroups[groupIndex + 1]}
              {@const diff = advertDiff(a, prevGroup?.first, group, prevGroup)}
              {@const canExpand = group.adverts.length > 1}
              {@const expanded = canExpand && expandedAdvertGroups.has(group.key)}
              <tr
                class="cursor-pointer hover:bg-elev"
                onclick={() => openAdvertDetails(a, group)}
              >
                <td class="px-3 py-2 whitespace-nowrap text-xs text-muted" title={fmtTime(a.at)}>
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
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted">
                  {#if group.hash}
                    <span class="font-mono" title={group.hash}>{shortHash(group.hash)}</span>
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted">{fmtTime(a.advertTime)}</td>
                <td class={diffCellClass(diff.name, 'px-3 py-2 max-w-[16rem] truncate')} title={a.name}>{a.name || '—'}</td>
                <td class={diffCellClass(diff.type, 'px-3 py-2 whitespace-nowrap')}>
                  <span title={TYPE_LABEL[a.type]} aria-label={TYPE_LABEL[a.type]}>
                    <NodeIcon type={a.type} size={15} class={diffValueClass(diff.type)} />
                  </span>
                </td>
                <td class={diffCellClass(diff.location, 'px-3 py-2 whitespace-nowrap font-mono text-xs')}>{a.hasGps ? fmtCoords(a.lat, a.lon) : '—'}</td>
                <td class="px-3 py-2 whitespace-nowrap text-xs text-muted">
                  {#if a.networkId}
                    <a
                      class="inline-flex hover:opacity-80"
                      href={networkUrl(a.networkId)}
                      target="_blank"
                      onclick={(event) => event.stopPropagation()}
                      rel="noreferrer"
                    >
                      <NetworkPill id={a.networkId} {catalog} />
                    </a>
                  {:else}—{/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-xs text-muted">
                  {#if groupAnalyzerPacketUrl(group)}
                    <a
                      class="hover:underline"
                      href={groupAnalyzerPacketUrl(group)}
                      onclick={(event) => event.stopPropagation()}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {analyzerGroupLabel(group)}
                    </a>
                  {:else}
                    <span>{analyzerGroupLabel(group)}</span>
                  {/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-xs text-muted">{observerLabel(group)}</td>
              </tr>
              {#if canExpand && expanded}
                {#each group.adverts as detail, detailIndex (`${group.key}-${detailIndex}`)}
                  {@const prevDetail = detailIndex === 0 ? a : group.adverts[detailIndex - 1]}
                  {@const detailDiff = advertDiff(detail, prevDetail)}
                  <tr
                    class="cursor-pointer bg-elev/40 hover:bg-elev"
                    onclick={() => openAdvertDetails(detail, group)}
                  >
                    <td class={diffCellClass(detailDiff.received, 'px-3 py-2 whitespace-nowrap text-xs')} title={fmtTime(detail.at)}>
                      <span class="pl-5">{fmtAgo(detail.at)}</span>
                    </td>
                    <td class={diffCellClass(detailDiff.hash, 'px-3 py-2 whitespace-nowrap font-mono text-xs')}>
                      {group.hash ? shortHash(group.hash) : '—'}
                    </td>
                    <td class={diffCellClass(detailDiff.advertTime, 'px-3 py-2 whitespace-nowrap font-mono text-xs')}>{fmtTime(detail.advertTime)}</td>
                    <td class={diffCellClass(detailDiff.name, 'px-3 py-2 max-w-[16rem] truncate')} title={detail.name}>{detail.name || '—'}</td>
                    <td class={diffCellClass(detailDiff.type, 'px-3 py-2 whitespace-nowrap')}>
                      <span title={TYPE_LABEL[detail.type]} aria-label={TYPE_LABEL[detail.type]}>
                        <NodeIcon type={detail.type} size={14} class={diffValueClass(detailDiff.type)} />
                      </span>
                    </td>
                    <td class={diffCellClass(detailDiff.location, 'px-3 py-2 whitespace-nowrap font-mono text-xs')}>
                      {detail.hasGps ? fmtCoords(detail.lat, detail.lon) : '—'}
                    </td>
                    <td class={diffCellClass(detailDiff.network, 'px-3 py-2 whitespace-nowrap text-xs')}>
                      {#if detail.networkId}
                        <a
                          class="inline-flex hover:opacity-80"
                          href={networkUrl(detail.networkId)}
                          target="_blank"
                          onclick={(event) => event.stopPropagation()}
                          rel="noreferrer"
                        >
                          <span class={detailDiff.network ? '' : 'opacity-60'}>
                            <NetworkPill id={detail.networkId} {catalog} />
                          </span>
                        </a>
                      {:else}—{/if}
                    </td>
                    <td class={diffCellClass(detailDiff.analyzer, 'px-3 py-2 whitespace-nowrap text-xs')}>
                      {#if analyzerPacketUrl(detail)}
                        <a
                          class={diffValueClass(detailDiff.analyzer, 'hover:underline')}
                          href={analyzerPacketUrl(detail)}
                          onclick={(event) => event.stopPropagation()}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {analyzerName(detail)}
                        </a>
                      {:else}
                        <span class={diffValueClass(detailDiff.analyzer)}>{analyzerName(detail)}</span>
                      {/if}
                    </td>
                    <td class={diffCellClass(detailDiff.observer, 'px-3 py-2 whitespace-nowrap text-xs')}>
                      <div>{detail.observerName || '—'}</div>
                      {#if detail.observerId}
                        {@const observerUrl = analyzerObserverUrl(detail)}
                        {#if observerUrl}
                          <a
                            class={diffValueClass(detailDiff.observer, 'font-mono text-[11px] hover:underline')}
                            href={observerUrl}
                            onclick={(event) => event.stopPropagation()}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortObserverId(detail.observerId)}
                          </a>
                        {:else}
                          <div class={diffValueClass(detailDiff.observer, 'font-mono text-[11px]')}>{shortObserverId(detail.observerId)}</div>
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
        <h2 class="mb-2 inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted">
          <span class="font-semibold">Map publishes</span>
          {@render helpTip('Captured snapshots of this node in the public map.meshcore.io directory. These are useful for unsigned map-only entries and for comparing map data with signed adverts.', 'history', 'https://map.meshcore.io', 'Open map directory')}
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
        <div class="overflow-hidden rounded-xl border border-edge">
          <table class="w-full table-fixed text-sm">
            <colgroup>
              <col class="w-[6.5rem]" />
              <col />
              <col class="w-14" />
              <col class="w-[11rem]" />
              <col class="w-[21rem]" />
            </colgroup>
            <thead class="bg-elev2 text-muted text-xs">
              <tr>
                <th class="text-left font-medium px-3 py-2">{@render labelHelp('Captured', 'When nodes.meshcore.ninja captured this map directory snapshot.', 'history')}</th>
                <th class="text-left font-medium px-3 py-2">{@render labelHelp('Name', 'Node name stored in the map directory snapshot.')}</th>
                <th class="text-left font-medium px-3 py-2 w-12">{@render labelHelp('Type', 'Node role stored in the map directory snapshot.')}</th>
                <th class="text-left font-medium px-3 py-2">{@render labelHelp('Location', 'Coordinates stored in the map directory snapshot.')}</th>
                <th class="text-left font-medium px-3 py-2">{@render labelHelp('Map details', 'Source, insert/update timestamps, submitter, and reported last advert are available here and in the row details modal.')}</th>
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
                  <td class="px-3 py-2 text-xs">
                    <div class="flex min-w-0 items-center gap-2 whitespace-nowrap">
                      <span class="truncate text-dim" title={pub.source || ''}>{pub.source || '—'}</span>
                      <span class="font-mono text-muted" title={pub.updatedDate || pub.insertedDate}>
                        {fmtPublishDate(pub.updatedDate || pub.insertedDate)}
                      </span>
                      {#if pub.updatedBy || pub.insertedBy}
                        <span class="truncate font-mono text-muted" title={pub.updatedBy || pub.insertedBy}>
                          by {shortKey8(pub.updatedBy || pub.insertedBy)}
                        </span>
                      {/if}
                    </div>
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
                        target="_blank"
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
                                target="_blank"
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
    </Tooltip.Provider>
    {/if}
</div>
{/if}

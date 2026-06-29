<script module>
  let lastSearchSnapshot = null;
</script>

<script>
  import { onMount } from 'svelte';
  import { Command } from 'bits-ui';
  import { LoaderCircle, LocateFixed, Search as SearchIcon, X } from '@lucide/svelte';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { search, searchOptions, meshNetworks, bands } from '$lib/api.js';
  import { focusSearchInput } from '$lib/search.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import LiveAdverts from '$lib/LiveAdverts.svelte';
  import { TYPE_LABEL, fmtAgo, shortKey, fmtCoords } from '$lib/format.js';

  // Network catalog (id → details), for resolving names + flags in results.
  let catalog = $state({});
  meshNetworks().then((c) => (catalog = c));

  // Band catalog (band id → { name, range, region, color }), for the band badge.
  let bandCatalog = $state({});
  bands().then((b) => (bandCatalog = b));

  // The LoRa band a result is on, derived from the first of its networks that
  // declares a radio config. null when unknown (e.g. map-only or radio-less nets).
  function nodeBand(n) {
    for (const id of n.networks ?? []) {
      const key = catalog[id]?.radio?.frequency;
      if (key != null && bandCatalog[String(key)]) return bandCatalog[String(key)];
    }
    return null;
  }

  function isStale(n) {
    if (!n?.lastAdvertAt) return false;
    return Date.now() / 1000 - n.lastAdvertAt > 14 * 86400;
  }

  // Seed search state synchronously from the URL (SPA: window is available at
  // init), so a result page is shareable/bookmarkable with no seeding effect.
  const sp0 = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const initialQuery = sp0.get('q') ?? '';
  const FILTER_KEYS = ['type', 'country', 'region', 'seen', 'has', 'source', 'near', 'sort'];
  const DEFAULT_COMMANDS = [
    {
      key: 'type',
      label: 'Type',
      values: [
        { value: 'repeater', label: 'Repeater' },
        { value: 'companion', label: 'Companion' },
        { value: 'room', label: 'Room' }
      ]
    },
    { key: 'country', label: 'Country', values: [{ value: 'CZ', label: 'CZ' }], placeholder: 'CZ' },
    { key: 'region', label: 'Region', values: [{ value: 'EU868', label: 'EU868' }], placeholder: 'EU868' },
    {
      key: 'seen',
      label: 'Seen',
      values: [
        { value: '<24h', label: 'Last 24 hours' },
        { value: '<7d', label: 'Last 7 days' },
        { value: '>30d', label: 'Older than 30 days' }
      ]
    },
    { key: 'has', label: 'Has', values: [{ value: 'location', label: 'Location' }, { value: 'name', label: 'Name' }] },
    {
      key: 'source',
      label: 'Source',
      values: [
        { value: 'advert', label: 'Advert' },
        { value: 'map', label: 'Map' },
        { value: 'corescope', label: 'CoreScope' }
      ]
    },
    { key: 'near', label: 'Near', placeholder: '50.0755,14.4378' },
    { key: 'sort', label: 'Sort', values: [{ value: 'recent', label: 'Recent' }, { value: 'name', label: 'Name' }, { value: 'distance', label: 'Distance' }] }
  ];

  function parseFilters(sp) {
    const out = [];
    for (const key of FILTER_KEYS) {
      for (const value of sp.getAll(key)) {
        if (!value) continue;
        const filter = { key, value };
        if (key === 'near' && sp.get('radius')) filter.radiusKm = Number(sp.get('radius'));
        out.push(filter);
      }
    }
    return out;
  }

  function filtersKey(list) {
    return (list ?? [])
      .map((f) => `${f.key}:${f.value}${f.radiusKm ? `:${f.radiusKm}` : ''}`)
      .join('|');
  }

  function writeFilters(sp, list) {
    for (const f of list ?? []) {
      sp.append(f.key, f.value);
      if (f.key === 'near' && f.radiusKm) sp.set('radius', String(f.radiusKm));
    }
  }

  function filterLabel(f) {
    const cmd = commands.find((c) => c.key === f.key);
    const value = cmd?.values?.find((v) => v.value === f.value)?.label ?? f.value;
    return f.key === 'near' && f.radiusKm ? `${f.key}:${value} radius:${f.radiusKm}km` : `${f.key}:${value}`;
  }

  function filterValues(key) {
    return filters.filter((f) => f.key === key).map((f) => f.value);
  }

  function hasFilter(key) {
    return filters.some((f) => f.key === key);
  }

  function fmtDistance(km) {
    if (!Number.isFinite(km)) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }

  function sourceLabel(source) {
    if (source === 'map') return 'map-only';
    if (source === 'corescope') return 'CoreScope';
    return 'observed advert';
  }

  function networkCountries(n) {
    const out = new Set();
    for (const id of n.networks ?? []) {
      for (const cc of catalog[id]?.coverage?.countries ?? []) out.add(String(cc).toUpperCase());
    }
    return [...out].sort();
  }

  function networkRegions(n) {
    const out = new Set();
    for (const id of n.networks ?? []) {
      const radios = Array.isArray(catalog[id]?.radios)
        ? catalog[id].radios
        : catalog[id]?.radio
          ? [catalog[id].radio]
          : [];
      for (const radio of radios) {
        const key = radio?.frequency;
        const region = radio?.region ?? (key != null ? bandCatalog[String(key)]?.region : '');
        if (region) out.add(String(region).toUpperCase());
      }
    }
    return [...out].sort();
  }

  function typeFilterMatched(n) {
    const values = filterValues('type');
    if (!values.length) return '';
    const typeName = TYPE_LABEL[n.type] === 'chat' ? 'companion' : TYPE_LABEL[n.type];
    return values.includes(typeName) ? typeName : '';
  }

  function resultInsights(n) {
    const items = [];
    const typeMatch = typeFilterMatched(n);
    if (typeMatch) items.push({ key: 'type', label: 'Type', value: typeMatch });
    if (hasFilter('near')) {
      const d = fmtDistance(n.distanceKm);
      items.push({ key: 'near', label: 'Distance', value: d || 'nearby' });
    }
    if (hasFilter('country')) {
      const wanted = new Set(filterValues('country'));
      const matched = networkCountries(n).filter((cc) => wanted.has(cc));
      if (matched.length) items.push({ key: 'country', label: 'Country', value: matched.join(', ') });
    }
    if (hasFilter('region')) {
      const wanted = new Set(filterValues('region'));
      const matched = networkRegions(n).filter((r) => wanted.has(r));
      if (matched.length) items.push({ key: 'region', label: 'Region', value: matched.join(', ') });
    }
    if (hasFilter('seen')) items.push({ key: 'seen', label: 'Seen', value: fmtAgo(n.lastAdvertAt) });
    if (hasFilter('has')) {
      if (filterValues('has').includes('location')) {
        items.push({ key: 'has-location', label: 'Location', value: n.hasGps ? fmtCoords(n.lat, n.lon) : 'missing' });
      }
      if (filterValues('has').includes('name')) {
        items.push({ key: 'has-name', label: 'Name', value: n.name || '(unnamed)' });
      }
    }
    if (hasFilter('source')) items.push({ key: 'source', label: 'Source', value: sourceLabel(n.source) });
    if (hasFilter('sort')) {
      const sort = filterValues('sort')[0];
      if (sort === 'distance' && !hasFilter('near')) items.push({ key: 'sort', label: 'Sort', value: 'distance' });
      else if (sort === 'name') items.push({ key: 'sort', label: 'Sort', value: 'name' });
      else if (sort === 'recent') items.push({ key: 'sort', label: 'Sort', value: 'recent' });
    }
    return items;
  }

  const initialCachedSearch =
    lastSearchSnapshot?.q === initialQuery.trim() &&
    lastSearchSnapshot?.filtersKey === filtersKey(parseFilters(sp0))
      ? lastSearchSnapshot
      : null;

  let q = $state(initialQuery);
  let filters = $state(parseFilters(sp0));
  let commands = $state(DEFAULT_COMMANDS);
  searchOptions().then((d) => {
    if (d.commands?.length) commands = d.commands;
  });
  let results = $state(initialCachedSearch?.results ?? []);
  let total = $state(initialCachedSearch?.total ?? 0);
  let capped = $state(initialCachedSearch?.capped ?? false);
  let loading = $state(false);
  let error = $state('');
  let ran = $state(!!initialCachedSearch); // a search has been issued at least once
  let selectedValue = $state(initialCachedSearch?.results?.[0]?.pubkey ?? '');
  let searchComputeMs = $state(initialCachedSearch?.computeMs ?? null);
  let searchApiMs = $state(initialCachedSearch?.apiMs ?? null);

  let inflight; // AbortController of the current request
  let searchSeq = 0;
  let completedQuery = initialCachedSearch?.q ?? '';
  let completedFiltersKey = initialCachedSearch?.filtersKey ?? '';
  let searchInput = $state(null);
  let focusNonce = 0;
  let searchFocused = $state(false);
  let draftCommand = $state(null);
  let valueDraft = $state('');
  let radiusDraft = $state('25');
  let locating = $state(false);
  let locationError = $state('');

  function focusSearchBox() {
    requestAnimationFrame(() => searchInput?.focus());
  }

  // ⌘K / Ctrl+K on the homepage, or arriving from another page via ?focus=search.
  $effect(() => {
    const n = $focusSearchInput;
    if (n !== focusNonce) {
      focusNonce = n;
      if (n > 0) focusSearchBox();
    }
  });

  $effect(() => {
    if ($page.url.searchParams.get('focus') !== 'search') return;
    focusSearchBox();
    const q = $page.url.searchParams.get('q') ?? '';
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    goto(`${base}/${qs}`, { replaceState: true, keepFocus: true, noScroll: true });
  });

  const hasQuery = $derived(q.trim() !== '' || filters.length > 0);
  const hasSearchEntry = $derived(
    q.trim() !== '' || filters.length > 0 || !!draftCommand || valueDraft.trim() !== ''
  );
  const currentToken = $derived(q.split(/\s+/).pop()?.replace(/:$/, '').toLowerCase() ?? '');
  const commandQuery = $derived(
    currentToken.startsWith('/') ? currentToken.slice(1) : null
  );
  function isCommandEntry(text) {
    const token = text.trim().split(/\s+/).pop()?.replace(/:$/, '').toLowerCase() ?? '';
    return token.startsWith('/');
  }
  const commandSuggestions = $derived(
    searchFocused && !draftCommand && commandQuery !== null
      ? commands.filter((c) => !commandQuery || c.key.startsWith(commandQuery)).slice(0, 8)
      : []
  );
  const activeCommandSuggestion = $derived(commandSuggestions[0] ?? null);
  const commandCompletionSuffix = $derived(
    activeCommandSuggestion &&
      commandQuery !== null &&
      activeCommandSuggestion.key !== commandQuery &&
      activeCommandSuggestion.key.startsWith(commandQuery)
      ? activeCommandSuggestion.key.slice(commandQuery.length)
      : ''
  );
  const valueSuggestions = $derived(
    draftCommand?.values?.length
      ? draftCommand.values
          .filter(
            (v) =>
              !valueDraft ||
              v.value.toLowerCase().includes(valueDraft.toLowerCase()) ||
              v.label.toLowerCase().includes(valueDraft.toLowerCase())
          )
          .slice(0, 8)
      : []
  );
  const activeValueSuggestion = $derived(valueSuggestions[0] ?? null);
  const valueCompletionSuffix = $derived(
    activeValueSuggestion &&
      valueDraft &&
      activeValueSuggestion.value.toLowerCase().startsWith(valueDraft.toLowerCase()) &&
      activeValueSuggestion.value !== valueDraft
      ? activeValueSuggestion.value.slice(valueDraft.length)
      : ''
  );
  // React to query changes: debounce, sync the URL, and search. This effect only
  // reads q (never writes it), so it can't loop. A snapshot is captured so the
  // async work doesn't re-read reactive state.
  let debounce;
  $effect(() => {
    const snap = { q: q.trim(), filters: filters.map((f) => ({ ...f })), filtersKey: filtersKey(filters) };
    clearTimeout(debounce);
    if (!snap.q && snap.filters.length === 0) {
      writeUrl(snap);
      runSearch(snap);
      return;
    }
    if (isCommandEntry(snap.q)) {
      writeUrl(snap);
      inflight?.abort();
      loading = false;
      if (!snap.filters.length) {
        ran = false;
        results = [];
        total = 0;
        capped = false;
        error = '';
        selectedValue = '';
        completedQuery = '';
        completedFiltersKey = '';
        searchComputeMs = null;
        searchApiMs = null;
      }
      return;
    }
    if (snap.q === completedQuery && snap.filtersKey === completedFiltersKey) {
      writeUrl(snap);
      return;
    }
    if (restoreCachedSearch(snap)) {
      writeUrl(snap);
      return;
    }
    debounce = setTimeout(() => {
      writeUrl(snap);
      runSearch(snap);
    }, 200);
    return () => clearTimeout(debounce);
  });

  // Open the value picker as soon as a command name is fully typed.
  $effect(() => {
    if (!searchFocused || draftCommand || commandQuery === null) return;
    const match = commands.find((c) => c.key === commandQuery);
    if (match) selectCommand(match);
  });

  function writeUrl(snap) {
    const sp = new URLSearchParams();
    if (snap.q) sp.set('q', snap.q);
    writeFilters(sp, snap.filters);
    const qs = sp.toString();
    goto(`${base}/${qs ? `?${qs}` : ''}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function restoreCachedSearch(snap) {
    if (isCommandEntry(snap.q)) return false;
    if (!hasQuery || lastSearchSnapshot?.q !== snap.q || lastSearchSnapshot?.filtersKey !== snap.filtersKey) return false;
    results = lastSearchSnapshot.results;
    total = lastSearchSnapshot.total;
    capped = lastSearchSnapshot.capped;
    ran = true;
    loading = false;
    error = '';
    selectedValue = results[0]?.pubkey ?? '';
    searchComputeMs = lastSearchSnapshot.computeMs;
    searchApiMs = lastSearchSnapshot.apiMs;
    completedQuery = snap.q;
    completedFiltersKey = snap.filtersKey;
    return true;
  }

  function rememberSearch(snap) {
    if (!snap.q && snap.filters.length === 0) return;
    if (isCommandEntry(snap.q)) return;
    lastSearchSnapshot = {
      q: snap.q,
      filtersKey: snap.filtersKey,
      results,
      total,
      capped,
      computeMs: searchComputeMs,
      apiMs: searchApiMs
    };
  }

  async function runSearch(snap) {
    if (!snap.q && snap.filters.length === 0) {
      searchSeq++;
      inflight?.abort();
      loading = false;
      results = [];
      total = 0;
      capped = false;
      ran = false;
      error = '';
      selectedValue = '';
      completedQuery = '';
      completedFiltersKey = '';
      searchComputeMs = null;
      searchApiMs = null;
      return [];
    }
    const seq = ++searchSeq;
    inflight?.abort();
    inflight = new AbortController();
    loading = true;
    error = '';
    ran = true;
    searchComputeMs = null;
    searchApiMs = null;
    try {
      const d = await search({ q: snap.q, filters: snap.filters, limit: 100 }, inflight.signal);
      if (seq !== searchSeq) return [];
      results = d.results ?? [];
      total = d.total ?? results.length;
      capped = !!d.capped;
      searchComputeMs = Number.isFinite(d.computeMs) ? d.computeMs : null;
      searchApiMs = Number.isFinite(d.apiMs) ? d.apiMs : null;
      selectedValue = results[0]?.pubkey ?? '';
      completedQuery = snap.q;
      completedFiltersKey = snap.filtersKey;
      rememberSearch(snap);
      return results;
    } catch (e) {
      if (e.name !== 'AbortError') {
        error = 'Search failed. Is the API reachable?';
        results = [];
        selectedValue = '';
        completedQuery = '';
        completedFiltersKey = '';
        searchComputeMs = null;
        searchApiMs = null;
      }
      return [];
    } finally {
      if (seq === searchSeq) loading = false;
    }
  }

  function openNode(node) {
    if (!node) return;
    goto(`${base}/${node.pubkey}`);
  }

  async function handleSearchKeydown(event) {
    if (draftCommand) {
      if (
        (event.key === 'Tab' || (event.key === 'Enter' && valueDraft)) &&
        activeValueSuggestion
      ) {
        event.preventDefault();
        commitDraftValue(activeValueSuggestion.value);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        commitDraftValue();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelDraftCommand();
      } else if (event.key === 'Backspace' && valueDraft === '') {
        event.preventDefault();
        cancelDraftCommand();
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && commandSuggestions.length) {
      event.preventDefault();
      selectCommand(commandSuggestions[0]);
      return;
    }
    if (event.key === 'Backspace' && q === '' && filters.length) {
      event.preventDefault();
      removeFilter(filters.length - 1);
      return;
    }
    if (event.key !== 'Enter') return;
    if (isCommandEntry(q)) return;
    const snap = { q: q.trim(), filters: filters.map((f) => ({ ...f })), filtersKey: filtersKey(filters) };
    if (!snap.q && snap.filters.length === 0) return;
    if (completedQuery === snap.q && completedFiltersKey === snap.filtersKey && results.length) return;

    event.preventDefault();
    clearTimeout(debounce);
    writeUrl(snap);
    const list = await runSearch(snap);
    openNode(list[0]);
  }

  function trimCurrentToken() {
    q = q.replace(/\S*$/, '').trimEnd();
  }

  function selectCommand(cmd) {
    trimCurrentToken();
    draftCommand = cmd;
    valueDraft = '';
    radiusDraft = '25';
    requestAnimationFrame(() => searchInput?.focus());
  }

  function cancelDraftCommand() {
    draftCommand = null;
    valueDraft = '';
    radiusDraft = '25';
    searchFocused = true;
    requestAnimationFrame(() => searchInput?.focus());
  }

  function clearSearch() {
    q = '';
    filters = [];
    draftCommand = null;
    valueDraft = '';
    radiusDraft = '25';
    locationError = '';
    requestAnimationFrame(() => searchInput?.focus());
  }

  async function submitSearch() {
    if (draftCommand) {
      commitDraftValue();
      return;
    }
    if (isCommandEntry(q)) return;
    const snap = { q: q.trim(), filters: filters.map((f) => ({ ...f })), filtersKey: filtersKey(filters) };
    if (!snap.q && snap.filters.length === 0) return;
    clearTimeout(debounce);
    writeUrl(snap);
    await runSearch(snap);
    requestAnimationFrame(() => searchInput?.focus());
  }

  function commitFilter(filter) {
    filters = [...filters.filter((f) => f.key !== filter.key || filter.key === 'has'), filter];
    draftCommand = null;
    valueDraft = '';
    radiusDraft = '25';
    requestAnimationFrame(() => searchInput?.focus());
  }

  function useCurrentLocation() {
    if (locating) return;
    locationError = '';
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      locationError = 'Location is not available in this browser.';
      return;
    }
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lon = pos.coords.longitude.toFixed(5);
        filters = [
          ...filters.filter((f) => f.key !== 'near' && f.key !== 'sort'),
          { key: 'near', value: `${lat},${lon}`, radiusKm: 25 },
          { key: 'sort', value: 'distance' }
        ];
        draftCommand = null;
        valueDraft = '';
        radiusDraft = '25';
        locating = false;
        requestAnimationFrame(() => searchInput?.focus());
      },
      (err) => {
        locationError =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied.'
            : 'Could not get your current location.';
        locating = false;
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }

  function commitDraftValue(value = valueDraft) {
    if (!draftCommand) return;
    const v = String(value ?? '').trim();
    if (!v) return;
    if (draftCommand.key === 'near') {
      const radius = Number(radiusDraft);
      if (!Number.isFinite(radius) || radius <= 0) return;
      commitFilter({ key: 'near', value: v, radiusKm: radius });
      return;
    }
    commitFilter({ key: draftCommand.key, value: v });
  }

  function removeFilter(i) {
    filters = filters.filter((_, idx) => idx !== i);
    searchFocused = true;
    requestAnimationFrame(() => searchInput?.focus());
  }

  function editFilter(i) {
    const f = filters[i];
    const cmd = commands.find((c) => c.key === f.key) ?? { key: f.key, label: f.key };
    removeFilter(i);
    draftCommand = cmd;
    valueDraft = f.value;
    radiusDraft = f.radiusKm ? String(f.radiusKm) : '25';
    requestAnimationFrame(() => searchInput?.focus());
  }

  function handleSearchInput(event) {
    if (draftCommand) valueDraft = event.currentTarget.value;
    else q = event.currentTarget.value;
  }

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return '(cached)';
    if (ms < 10) return `${ms.toFixed(1)} ms`;
    return `${Math.round(ms)} ms`;
  }

  function fmtApiMs(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return '(cached)';
    return `${Math.round(ms)} ms`;
  }

  onMount(() => {
    requestAnimationFrame(() => searchInput?.focus());
  });
</script>

<svelte:head>
  <title>MeshCore Nodes — search the mesh</title>
</svelte:head>

<section
  class="w-full mx-auto max-w-3xl min-w-0 px-4 transition-all"
  class:pt-[18vh]={!hasQuery}
  class:pt-10={hasQuery}
>
  <div class="text-center mb-6" class:mb-3={hasQuery}>
    <a href="{base}/" class="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <span class="text-accent"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-dot-icon lucide-circle-dot"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/></svg></span> nodes.meshcore.ninja
    </a>
    {#if !hasQuery}
      <p class="text-dim mt-2">
        A searchable directory of MeshCore nodes, built from observed signed adverts.
      </p>
    {/if}
  </div>

  <Command.Root
    label="Search nodes"
    shouldFilter={false}
    disableInitialScroll={true}
    bind:value={selectedValue}
  >
    <!-- Dominant search input -->
    <div class="relative">
      <div
        class="flex min-h-16 w-full flex-wrap items-center gap-2 rounded-xl border border-edge bg-elev px-3 py-3 text-lg outline-none transition
               focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30"
      >
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {#each filters as f, i (`${f.key}-${f.value}-${i}`)}
            <span class="inline-flex max-w-full items-center overflow-hidden rounded-lg border border-accent/35 bg-accent/10 text-sm text-ink">
              <button
                type="button"
                class="min-w-0 px-2.5 py-1"
                title="Edit filter"
                onclick={(event) => {
                  event.stopPropagation();
                  editFilter(i);
                }}
              >
                <span class="block truncate">{filterLabel(f)}</span>
              </button>
              <button
                type="button"
                class="px-2 py-1 text-muted hover:text-ink"
                aria-label="Remove filter"
                onclick={(event) => {
                  event.stopPropagation();
                  removeFilter(i);
                }}
              >
                x
              </button>
            </span>
          {/each}
          {#if draftCommand}
            <span class="inline-flex max-w-full items-center gap-1 rounded-lg border border-edge bg-elev2 px-2.5 py-1 text-sm">
              <span class="shrink-0 text-accent">{draftCommand.key}:</span>
              <span class="relative min-w-20">
                {#if valueCompletionSuffix}
                  <span
                    aria-hidden="true"
                    class="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 whitespace-pre text-sm"
                  >
                    <span class="text-transparent">{valueDraft}</span><span class="text-muted/45">{valueCompletionSuffix}</span>
                    <span class="ml-1.5 rounded border border-edge px-1 py-0.5 align-middle text-[0.6rem] uppercase tracking-wide text-muted/70">
                      Tab
                    </span>
                  </span>
                {/if}
                <input
                  bind:this={searchInput}
                  type="text"
                  value={valueDraft}
                  oninput={handleSearchInput}
                  placeholder={draftCommand.placeholder || 'value'}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  onfocus={() => (searchFocused = true)}
                  onblur={() => setTimeout(() => (searchFocused = false), 120)}
                  onkeydown={handleSearchKeydown}
                  class="relative w-36 min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
                />
              </span>
            </span>
          {:else}
            <span class="relative min-w-32 flex-1">
              {#if commandCompletionSuffix}
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 whitespace-pre text-lg"
                >
                  <span class="text-transparent">{q}</span><span class="text-muted/45">{commandCompletionSuffix}</span>
                  <span class="ml-2 rounded border border-edge px-1.5 py-0.5 align-middle text-[0.65rem] uppercase tracking-wide text-muted/70">
                    Tab
                  </span>
                </span>
              {/if}
              <input
                bind:this={searchInput}
                type="text"
                value={q}
                oninput={handleSearchInput}
                placeholder={filters.length ? '' : 'Search by name or public key, or type /filter…'}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                onfocus={() => (searchFocused = true)}
                onblur={() => setTimeout(() => (searchFocused = false), 120)}
                onkeydown={handleSearchKeydown}
                class="relative w-full bg-transparent text-lg outline-none placeholder:text-muted"
              />
            </span>
          {/if}
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          {#if loading}
            <LoaderCircle size={18} class="animate-spin text-accent" aria-label="Searching" />
          {/if}
          {#if hasSearchEntry}
            <button
              type="button"
              class="grid h-10 w-10 place-items-center rounded-lg border border-edge text-dim transition hover:border-bad hover:text-bad"
              title="Clear search"
              aria-label="Clear search"
              onclick={(event) => {
                event.stopPropagation();
                clearSearch();
              }}
            >
              <X size={18} />
            </button>
          {/if}
          <button
            type="button"
            class="grid h-10 w-10 place-items-center rounded-lg border border-edge text-dim transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
            title={locating ? 'Getting current location' : 'Use current location'}
            aria-label={locating ? 'Getting current location' : 'Use current location'}
            disabled={locating}
            onclick={(event) => {
              event.stopPropagation();
              useCurrentLocation();
            }}
          >
            <LocateFixed size={18} class={locating ? 'animate-spin' : ''} />
          </button>
          {#if hasSearchEntry}
            <button
              type="button"
              class="grid h-10 w-10 place-items-center rounded-lg border border-accent/50 bg-accent/10 text-accent transition hover:bg-accent hover:text-bg"
              title="Search"
              aria-label="Search"
              onclick={(event) => {
                event.stopPropagation();
                submitSearch();
              }}
            >
              <SearchIcon size={18} />
            </button>
          {/if}
        </div>
      </div>
      {#if locationError}
        <p class="mt-2 text-sm text-bad">{locationError}</p>
      {/if}
      {#if commandSuggestions.length}
        <div class="mt-3 flex h-16 items-center gap-2 overflow-x-auto rounded-lg border border-edge bg-elev px-2 shadow-sm">
          {#each commandSuggestions as cmd, i (cmd.key)}
            <button
              type="button"
              class={`flex h-11 shrink-0 items-center gap-3 rounded-md border px-3 text-left outline-none transition hover:bg-elev2 ${
                i === 0 ? 'border-accent bg-accent/10' : 'border-edge'
              }`}
              onmousedown={(event) => {
                event.preventDefault();
                selectCommand(cmd);
              }}
            >
              <span class="font-medium">/{cmd.key}</span>
              <span class="text-sm text-muted">{cmd.label}</span>
              {#if i === 0}
                <span class="rounded border border-accent/35 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-accent">
                  Tab
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {:else if draftCommand}
        <div class="mt-3 rounded-lg border border-edge bg-elev p-2 shadow-sm">
          {#if draftCommand.key === 'near'}
            <div class="grid grid-cols-[1fr_auto] gap-2">
              <input
                bind:value={radiusDraft}
                inputmode="decimal"
                aria-label="Radius in kilometers"
                class="rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                onkeydown={handleSearchKeydown}
              />
              <button
                type="button"
                class="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg"
                onmousedown={(event) => {
                  event.preventDefault();
                  commitDraftValue();
                }}
              >
                Add
              </button>
            </div>
          {:else if draftCommand.values?.length}
            <div class="grid max-h-40 grid-cols-1 gap-1 overflow-auto py-1 sm:grid-cols-2">
              {#each valueSuggestions as opt, i (opt.value)}
                <button
                  type="button"
                  class={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-elev2 ${
                    i === 0 ? 'border-accent bg-accent/10' : 'border-transparent'
                  }`}
                  onmousedown={(event) => {
                    event.preventDefault();
                    commitDraftValue(opt.value);
                  }}
                >
                  <span>{opt.label}</span>
                  <span class="flex items-center gap-2">
                    <span class="font-mono text-xs text-muted">{opt.value}</span>
                    {#if i === 0}
                      <span class="rounded border border-accent/35 px-1 py-0.5 text-[0.6rem] uppercase tracking-wide text-accent">
                        Tab
                      </span>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          {:else}
            <div class="flex gap-2">
              <input
                bind:value={valueDraft}
                placeholder={draftCommand.placeholder || 'value'}
                class="min-w-0 flex-1 rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                onkeydown={handleSearchKeydown}
              />
              <button
                type="button"
                class="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg"
                onmousedown={(event) => {
                  event.preventDefault();
                  commitDraftValue();
                }}
              >
                Add
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Results -->
    {#if ran}
      <div class="mt-4">
        {#if error}
          <p class="text-bad text-sm">{error}</p>
        {:else if loading && results.length === 0}
          <!-- In-flight with nothing to show yet: animated skeleton, never a
               premature "0 matches" (which looks like a finished empty search). -->
          <div class="mb-2 flex items-center gap-2 text-xs text-muted">
            <LoaderCircle size={14} class="animate-spin text-accent" aria-hidden="true" />
            <span>Searching the mesh…</span>
          </div>
          <div
            class="divide-y divide-edge rounded-xl border border-edge overflow-hidden"
            role="status"
            aria-busy="true"
            aria-label="Searching"
          >
            {#each Array(5) as _, i (i)}
              <div class="flex items-center gap-3 px-4 py-3">
                <span class="h-5 w-5 shrink-0 animate-pulse rounded-full bg-elev2"></span>
                <span class="min-w-0 flex-1 space-y-2">
                  <span
                    class="block h-3.5 animate-pulse rounded bg-elev2"
                    style={`width:${[55, 40, 65, 48, 58][i]}%`}
                  ></span>
                  <span class="block h-3 w-32 animate-pulse rounded bg-elev2/70"></span>
                </span>
                <span class="hidden h-3 w-16 shrink-0 animate-pulse rounded bg-elev2/70 sm:block"></span>
              </div>
            {/each}
          </div>
        {:else if results.length === 0}
          <p class="text-dim text-sm">No nodes match.</p>
        {:else}
          <div class="mb-2 flex items-baseline justify-between gap-4 text-xs text-muted">
            <span class="flex items-center gap-2">
              {#if loading}
                <LoaderCircle size={13} class="animate-spin text-accent" aria-hidden="true" />
                <span>Updating…</span>
              {:else}
                {total} match{total === 1 ? '' : 'es'}{capped ? ` · showing first ${results.length}` : ''}
              {/if}
            </span>
            <span class="shrink-0 text-right tabular-nums opacity-60">
              search {fmtMs(searchComputeMs)} · api {fmtApiMs(searchApiMs)}
            </span>
          </div>
          <Command.List
            id="node-search-results"
            class="divide-y divide-edge rounded-xl border border-edge overflow-hidden"
          >
            {#each results as n (n.pubkey)}
              {@const band = nodeBand(n)}
              {@const insights = resultInsights(n)}
              <Command.LinkItem
                href="{base}/{n.pubkey}"
                value={n.pubkey}
                onSelect={() => openNode(n)}
                class="flex items-center gap-3 border-l-2 border-transparent px-4 py-3 transition-colors outline-none data-[selected]:border-accent data-[selected]:bg-elev"
              >
                <NodeIcon type={n.type} size={20} class="shrink-0 text-dim" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate font-medium">{n.name || '(unnamed)'}</span>
                    {#if n.source === 'map'}
                      <span
                        class="shrink-0 rounded-full border border-accent2/40 px-1.5 py-px text-[0.6rem] uppercase tracking-wide text-accent2"
                        title="Only on map.meshcore.io — not yet observed by our analyzers"
                      >
                        Map-only
                      </span>
                    {/if}
                    {#if isStale(n)}
                      <span
                        class="shrink-0 rounded-full border border-warn/40 bg-warn/10 px-1.5 py-px text-[0.6rem] uppercase tracking-wide text-warn"
                        title="No recent advert observed in the last 14 days"
                      >
                        Stale
                      </span>
                    {/if}
                  </span>
                  <span class="block truncate text-xs text-muted font-mono">{shortKey(n.pubkey)}</span>
                  {#if insights.length}
                    <span class="mt-1 flex flex-wrap items-center gap-1.5">
                      {#each insights as item (item.key)}
                        <span
                          class="inline-flex max-w-full items-center gap-1 rounded-md border border-edge bg-bg/60 px-1.5 py-0.5 text-[0.68rem] text-dim"
                          title={`${item.label}: ${item.value}`}
                        >
                          <span class="uppercase tracking-wide text-muted">{item.label}</span>
                          <span class="truncate text-ink">{item.value}</span>
                        </span>
                      {/each}
                    </span>
                  {/if}
                  <span class="mt-1 block text-xs text-dim sm:hidden">
                    <span class="capitalize">{TYPE_LABEL[n.type]}</span>
                    {#if band}
                      <span
                        class="ml-1 rounded-full border px-1.5 py-px text-[0.65rem] font-semibold"
                        style={band.color
                          ? `color:${band.color};border-color:${band.color}66;background-color:${band.color}1f`
                          : ''}
                        title={`${band.range} · ${band.region}`}
                      >
                        {band.region}
                      </span>
                    {/if}
                    {#if n.hasGps}<span> · {fmtCoords(n.lat, n.lon)}</span>{/if}
                    <span> · {fmtAgo(n.lastAdvertAt)}</span>
                  </span>
                  {#if n.networks?.length}
                    <span class="mt-1 flex flex-wrap items-center gap-1">
                      {#each n.networks as net}
                        <NetworkPill id={net} {catalog} />
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class="hidden sm:block text-xs text-dim text-right whitespace-nowrap">
                  {#if hasFilter('near') && n.distanceKm != null}
                    <span class="block text-sm font-medium text-ink">{fmtDistance(n.distanceKm)}</span>
                  {/if}
                  <span class="flex items-center justify-end gap-1.5">
                    <span class="capitalize">{TYPE_LABEL[n.type]}</span>
                    {#if band}
                      <span
                        class="rounded-full border px-1.5 py-px text-[0.65rem] font-semibold"
                        style={band.color
                          ? `color:${band.color};border-color:${band.color}66;background-color:${band.color}1f`
                          : ''}
                        title={`${band.range} · ${band.region}`}
                      >
                        {band.region}
                      </span>
                    {/if}
                  </span>
                  {#if n.hasGps}<span class="block">{fmtCoords(n.lat, n.lon)}</span>{/if}
                  <span class="block">{fmtAgo(n.lastAdvertAt)}</span>
                </span>
                <span class="text-muted">→</span>
              </Command.LinkItem>
            {/each}
          </Command.List>
        {/if}
      </div>
    {/if}
  </Command.Root>

  {#if !hasQuery}
    <LiveAdverts />
  {/if}
</section>

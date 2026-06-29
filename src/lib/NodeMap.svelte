<script module>
  // Shared across all NodeMap instances — survives profile navigation.
  let mapCtrl = null;
  let mapEl = null;
  let mapParent = null;
  let parkHost = null;
  let lastHostW = 0;
  let lastHostH = 0;
  let lastNeighborFit = 0;
  let lastNodeKey = '';
  const liveData = { lat: 0, lon: 0, hasGps: false, links: [] };
  const ui = {
    onHoverTip: null,
    onZoom: null,
    onFocusHome: null,
    closeModal: null
  };

  function getMapEl() {
    if (!mapEl) {
      mapEl = document.createElement('div');
      mapEl.className = 'nm-map h-full w-full';
    }
    return mapEl;
  }

  function getParkHost() {
    if (!parkHost) {
      parkHost = document.createElement('div');
      parkHost.setAttribute('aria-hidden', 'true');
      parkHost.style.cssText =
        'position:fixed;left:-10000px;top:0;display:none;overflow:hidden;pointer-events:none';
      document.body.appendChild(parkHost);
    }
    return parkHost;
  }

  function attachMap(host) {
    if (!host) return;
    const shell = getMapEl();
    if (mapParent === host && shell.parentElement === host) return;
    host.appendChild(shell);
    mapParent = host;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w > 0) lastHostW = w;
    if (h > 0) lastHostH = h;
    requestAnimationFrame(() => {
      if (!mapCtrl?.map || mapParent !== host) return;
      mapCtrl.map.resize();
    });
  }

  function detachMap() {
    if (!mapEl || !mapParent) return;
    const w = mapParent.clientWidth;
    const h = mapParent.clientHeight;
    if (w > 0) lastHostW = w;
    if (h > 0) lastHostH = h;
    const park = getParkHost();
    park.style.width = `${lastHostW}px`;
    park.style.height = `${lastHostH}px`;
    park.appendChild(mapEl);
    mapParent = null;
  }
</script>

<script>
  // MapLibre node map — same basemap + layer patterns as map.meshcore.ninja.
  import { onMount, onDestroy, untrack } from 'svelte';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { Dialog } from 'bits-ui';
  import maplibregl from 'maplibre-gl';
  import { basemapStyle, basemapTiles, currentTheme } from '$lib/basemaps.js';
  import { TYPE_LABEL, fmtAgo } from '$lib/format.js';

  const props = $props();
  const lat = $derived(Number(props.lat));
  const lon = $derived(Number(props.lon));
  const hasGps = $derived(!!props.hasGps);
  const links = $derived(props.links ?? []);

  const LINK_COLOR = '#a855f7';
  const NODE_COLOR = '#4dd0a7';
  const NODE_HIT_RADIUS = ['interpolate', ['linear'], ['zoom'], 4, 18, 8, 22, 12, 26];
  const NEIGHBOR_HIT_RADIUS = [
    'max',
    ['+', ['coalesce', ['get', 'radius'], 3], 10],
    14
  ];
  const LAYER_STACK = [
    'nm-links',
    'nm-neighbors',
    'nm-neighbor-hit',
    'nm-hover',
    'nm-node-hover',
    'nm-node',
    'nm-node-hit'
  ];

  let inlineHost;
  let modalHost = $state();
  let themeObserver;
  let ready = $state(false);
  let modalOpen = $state(false);
  let zoomOn = $state(false);
  let showNeighbors = $state(true);
  let mapHover = $state(null);

  function ensureMap() {
    if (mapCtrl) return mapCtrl;
    mapCtrl = initMap(getMapEl(), {
      onZoom: (on) => ui.onZoom?.(on),
      onHoverTip: (t) => ui.onHoverTip?.(t),
      onFocusHome: () => ui.onFocusHome?.(),
      closeModal: () => ui.closeModal?.(),
      getData: () => liveData
    });
    return mapCtrl;
  }

  const hasNeighborLocations = $derived(links.some(linkHasLocation));
  const hasLocation = $derived(hasGps && validCoord(lat, lon));

  function toggleNeighbors() {
    showNeighbors = !showNeighbors;
    mapCtrl?.setNeighborsVisible(showNeighbors);
    if (showNeighbors) mapCtrl?.fitGroupIfNeeded({ animate: true });
  }

  function onFocusHome() {
    showNeighbors = false;
  }

  function validCoord(a, b) {
    return Number.isFinite(a) && Number.isFinite(b);
  }

  function linkHasLocation(link) {
    const n = link?.neighbor;
    return !!n?.hasGps && validCoord(Number(n.lat), Number(n.lon));
  }

  function haversineKm(aLat, aLon, bLat, bLon) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function fmtKm(km) {
    if (km == null) return '';
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
  }

  function tipFields(l) {
    const n = l.neighbor;
    const name = n.name || n.pubkey.slice(0, 8);
    const dist =
      hasLocation && validCoord(Number(n.lat), Number(n.lon))
        ? haversineKm(lat, lon, Number(n.lat), Number(n.lon))
        : null;
    const sub1 = [TYPE_LABEL[n.type] || 'node', dist != null ? fmtKm(dist) : '']
      .filter(Boolean)
      .join(' · ');
    const sub2 = `${(l.packetCount || 0).toLocaleString()} pkts · ${fmtAgo(l.lastSeen)}`;
    return { name, sub1, sub2 };
  }

  function emptyCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function initMap(container, { onZoom, onHoverTip, onFocusHome, closeModal, getData }) {
    const map = new maplibregl.Map({
      container,
      style: basemapStyle(currentTheme()),
      center: [0, 20],
      zoom: 2,
      minZoom: 1,
      maxZoom: 18,
      scrollZoom: false,
      attributionControl: false,
      fadeDuration: 0
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    let locatedLinks = [];
    let zoomOn = false;
    let eventsBound = false;
    let mapReady = false;
    let focusingHome = false;

    function enableZoom() {
      if (zoomOn) return;
      zoomOn = true;
      map.scrollZoom.enable();
      onZoom?.(true);
    }

    map.on('click', enableZoom);
    map.on('dragstart', enableZoom);
    map.once('load', () => {
      const zoomCtl = container.querySelector('.maplibregl-ctrl-zoom');
      if (zoomCtl) zoomCtl.addEventListener('click', enableZoom);
      onZoom?.(zoomOn);
    });

    function clearHoverTip() {
      onHoverTip?.(null);
    }

    function clearHoverRing() {
      map.getSource('nm-hover')?.setData(emptyCollection());
    }

    function clearNodeHover() {
      map.getSource('nm-node-hover')?.setData(emptyCollection());
    }

    function isOverHomeNode(point) {
      if (!map.getLayer('nm-node-hit')) return false;
      return (
        map.queryRenderedFeatures(point, { layers: ['nm-node-hit'] }).length > 0
      );
    }

    function showNodeHover() {
      const { lat: nodeLat, lon: nodeLon, hasGps: gps } = getData();
      const nLat = Number(nodeLat);
      const nLon = Number(nodeLon);
      if (!gps || !validCoord(nLat, nLon)) return;
      map.getCanvas().style.cursor = 'pointer';
      clearHoverRing();
      clearHoverTip();
      map.getSource('nm-node-hover')?.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [nLon, nLat] }
          }
        ]
      });
    }

    function setNeighborsVisible(visible) {
      const v = visible ? 'visible' : 'none';
      for (const id of ['nm-links', 'nm-neighbors', 'nm-neighbor-hit', 'nm-hover']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
      }
      if (!visible) {
        clearHoverRing();
        clearHoverTip();
        clearNodeHover();
      }
    }

    function restackLayers() {
      for (const id of LAYER_STACK) {
        if (map.getLayer(id)) map.moveLayer(id);
      }
    }

    function teardownLayers() {
      for (const id of [...LAYER_STACK].reverse()) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of LAYER_STACK) {
        if (map.getSource(id)) map.removeSource(id);
      }
    }

    function addLayers() {
      if (map.getSource('nm-links')) return;

      map.addSource('nm-links', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'nm-links',
        type: 'line',
        source: 'nm-links',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': LINK_COLOR,
          'line-width': ['coalesce', ['get', 'width'], 1],
          'line-opacity': 1
        }
      });

      map.addSource('nm-neighbors', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'nm-neighbors',
        type: 'circle',
        source: 'nm-neighbors',
        paint: {
          'circle-color': LINK_COLOR,
          'circle-radius': ['coalesce', ['get', 'radius'], 3],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#0d1117',
          'circle-stroke-width': 0.75
        }
      });

      map.addLayer({
        id: 'nm-neighbor-hit',
        type: 'circle',
        source: 'nm-neighbors',
        paint: {
          'circle-color': 'transparent',
          'circle-radius': NEIGHBOR_HIT_RADIUS,
          'circle-opacity': 0
        }
      });

      map.addSource('nm-hover', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'nm-hover',
        type: 'circle',
        source: 'nm-hover',
        paint: {
          'circle-color': 'transparent',
          'circle-radius': ['coalesce', ['get', 'radius'], 6],
          'circle-stroke-color': LINK_COLOR,
          'circle-stroke-width': 1.75,
          'circle-stroke-opacity': 0.95
        }
      });

      map.addSource('nm-node-hover', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'nm-node-hover',
        type: 'circle',
        source: 'nm-node-hover',
        paint: {
          'circle-color': 'transparent',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 14],
          'circle-stroke-color': NODE_COLOR,
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.95
        }
      });

      map.addSource('nm-node', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'nm-node',
        type: 'circle',
        source: 'nm-node',
        paint: {
          'circle-color': NODE_COLOR,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 12, 8],
          'circle-opacity': 1,
          'circle-stroke-color': '#0d1117',
          'circle-stroke-width': 1.5
        }
      });

      map.addLayer({
        id: 'nm-node-hit',
        type: 'circle',
        source: 'nm-node',
        paint: {
          'circle-color': 'transparent',
          'circle-radius': NODE_HIT_RADIUS,
          'circle-opacity': 0
        }
      });

      restackLayers();

      if (!eventsBound) {
        eventsBound = true;
        map.on('movestart', () => {
          clearHoverRing();
          clearHoverTip();
          clearNodeHover();
        });

        map.on('mousemove', 'nm-node-hit', () => {
          showNodeHover();
        });

        map.on('mouseleave', 'nm-node-hit', () => {
          map.getCanvas().style.cursor = '';
          clearNodeHover();
        });

        map.on('click', 'nm-node-hit', () => {
          focusHome();
        });

        map.on('mousemove', 'nm-neighbor-hit', (e) => {
          if (isOverHomeNode(e.point)) {
            showNodeHover();
            return;
          }
          const f = e.features?.[0];
          if (!f) return;
          map.getCanvas().style.cursor = 'pointer';
          const l = locatedLinks[f.properties.i];
          if (!l) return;
          const r = f.properties.radius + 4;
          map.getSource('nm-hover')?.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { radius: r },
                geometry: { type: 'Point', coordinates: f.geometry.coordinates }
              }
            ]
          });
          onHoverTip?.({
            link: l,
            x: e.point.x,
            y: e.point.y,
            below: e.point.y < 72
          });
        });

        map.on('mouseleave', 'nm-neighbor-hit', () => {
          map.getCanvas().style.cursor = '';
          clearHoverRing();
          clearHoverTip();
        });

        map.on('click', 'nm-neighbor-hit', (e) => {
          if (isOverHomeNode(e.point)) return;
          const f = e.features?.[0];
          const l = locatedLinks[f?.properties?.i];
          if (!l) return;
          enableZoom();
          closeModal?.();
          goto(`${base}/${l.neighbor.pubkey}`);
        });
      }
    }

    function applyProjection() {
      map.setProjection({ type: 'globe' });
    }

    function groupPoints() {
      const { lat: nodeLat, lon: nodeLon, hasGps: gps, links: allLinks } = getData();
      const nLat = Number(nodeLat);
      const nLon = Number(nodeLon);
      if (!gps || !validCoord(nLat, nLon)) return [];
      const pts = [[nLat, nLon]];
      for (const l of allLinks.filter(linkHasLocation)) {
        pts.push([Number(l.neighbor.lat), Number(l.neighbor.lon)]);
      }
      return pts;
    }

    function viewCoversGroup(padding = 40) {
      const pts = groupPoints();
      if (!pts.length) return false;
      const w = map.getCanvas().clientWidth;
      const h = map.getCanvas().clientHeight;
      if (!w || !h) return false;
      return pts.every(([pLat, pLon]) => {
        const p = map.project([pLon, pLat]);
        return p.x >= padding && p.x <= w - padding && p.y >= padding && p.y <= h - padding;
      });
    }

    function fitGroup({ animate = false } = {}) {
      const pts = groupPoints();
      if (!pts.length) return;
      const nLon = pts[0][1];
      const nLat = pts[0][0];
      if (pts.length <= 1) {
        if (animate) map.flyTo({ center: [nLon, nLat], zoom: 11, duration: 600, essential: true });
        else map.jumpTo({ center: [nLon, nLat], zoom: 11 });
        return;
      }
      const bounds = new maplibregl.LngLatBounds();
      for (const [pLat, pLon] of pts) bounds.extend([pLon, pLat]);
      map.fitBounds(bounds, {
        padding: 48,
        duration: animate ? 600 : 0,
        maxZoom: 14,
        essential: true
      });
    }

    function fitGroupIfNeeded({ animate = false } = {}) {
      if (viewCoversGroup()) return;
      fitGroup({ animate });
    }

    function getView() {
      const c = map.getCenter();
      return {
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch()
      };
    }

    function setView(view) {
      if (!view?.center) return;
      map.jumpTo({
        center: view.center,
        zoom: view.zoom,
        bearing: view.bearing ?? 0,
        pitch: view.pitch ?? 0
      });
    }

    function focusHome() {
      const { lat: nodeLat, lon: nodeLon, hasGps: gps } = getData();
      const nLat = Number(nodeLat);
      const nLon = Number(nodeLon);
      if (!gps || !validCoord(nLat, nLon) || focusingHome) return;
      focusingHome = true;
      enableZoom();
      clearNodeHover();
      setNeighborsVisible(false);
      onFocusHome?.();
      map.stop();
      map.flyTo({
        center: [nLon, nLat],
        zoom: Math.max(map.getZoom(), 12),
        duration: 600,
        essential: true
      });
      map.once('moveend', () => {
        focusingHome = false;
      });
    }

    function draw({ fitView = true } = {}) {
      if (!mapReady) return;

      const { lat: nodeLat, lon: nodeLon, hasGps: gps, links: allLinks } = getData();
      const nLat = Number(nodeLat);
      const nLon = Number(nodeLon);
      const linkFeatures = [];
      const neighborFeatures = [];
      const nodeHasLocation = gps && validCoord(nLat, nLon);

      if (nodeHasLocation) {
        locatedLinks = allLinks.filter(linkHasLocation);
        const maxPkt = locatedLinks.reduce((mx, l) => Math.max(mx, l.packetCount || 0), 0) || 1;
        const totalPkt = locatedLinks.reduce((sum, l) => sum + (l.packetCount || 0), 0) || 1;

        locatedLinks.forEach((l, i) => {
          const n = l.neighbor;
          const nbLat = Number(n.lat);
          const nbLon = Number(n.lon);
          const ratio = (l.packetCount || 0) / maxPkt;
          const share = (l.packetCount || 0) / totalPkt;
          const width = 0.4 + Math.pow(ratio, 1.6) * 8.6;
          const radius = 2 + Math.pow(share, 0.55) * 4.5;
          linkFeatures.push({
            type: 'Feature',
            properties: { width },
            geometry: {
              type: 'LineString',
              coordinates: [
                [nLon, nLat],
                [nbLon, nbLat]
              ]
            }
          });
          neighborFeatures.push({
            type: 'Feature',
            properties: { i, radius },
            geometry: { type: 'Point', coordinates: [nbLon, nbLat] }
          });
        });

        map.getSource('nm-node')?.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: [nLon, nLat] }
            }
          ]
        });
      } else {
        locatedLinks = [];
        map.getSource('nm-node')?.setData(emptyCollection());
      }

      map.getSource('nm-links')?.setData({ type: 'FeatureCollection', features: linkFeatures });
      map.getSource('nm-neighbors')?.setData({ type: 'FeatureCollection', features: neighborFeatures });

      if (fitView) {
        if (nodeHasLocation) fitGroupIfNeeded();
        else map.jumpTo({ center: [0, 20], zoom: 1.5 });
      }
    }

    function afterStyleReady({ fitView = false } = {}) {
      if (!map.getSource('nm-links')) addLayers();
      else restackLayers();
      applyProjection();
      draw({ fitView });
    }

    map.on('load', () => {
      mapReady = true;
      map.resize();
      addLayers();
      applyProjection();
      draw({ fitView: true });
      onZoom?.(zoomOn);
    });

    function syncZoom() {
      onZoom?.(zoomOn);
    }

    function clear() {
      locatedLinks = [];
      clearHoverRing();
      clearHoverTip();
      clearNodeHover();
      if (!mapReady) return;
      map.getCanvas().style.cursor = '';
      const empty = emptyCollection();
      for (const id of ['nm-links', 'nm-neighbors', 'nm-hover', 'nm-node-hover', 'nm-node']) {
        map.getSource(id)?.setData(empty);
      }
    }

    return {
      map,
      draw,
      clear,
      fitGroup,
      fitGroupIfNeeded,
      focusHome,
      getView,
      setView,
      setNeighborsVisible,
      syncZoom,
      setTheme() {
        const theme = currentTheme();
        const cur = map.getStyle()?.sources?.carto?.tiles?.[0] ?? '';
        const next = basemapTiles(theme)[0] ?? '';
        if (cur === next) return;
        map.setStyle(basemapStyle(theme));
        map.once('styledata', () => afterStyleReady({ fitView: false }));
      },
      refresh(preserveView) {
        const view = preserveView === true ? getView() : preserveView;
        map.resize();
        if (!mapReady) return;
        draw({ fitView: !view });
        if (view) setView(view);
      },
      enableZoom,
      destroy() {
        teardownLayers();
        map.remove();
        mapCtrl = null;
        mapEl = null;
        mapParent = null;
      }
    };
  }

  onMount(() => {
    ui.onHoverTip = (t) => (mapHover = t);
    ui.onZoom = (on) => (zoomOn = on);
    ui.onFocusHome = onFocusHome;
    ui.closeModal = () => {
      modalOpen = false;
    };

    liveData.lat = lat;
    liveData.lon = lon;
    liveData.hasGps = hasGps;
    liveData.links = links;
    ensureMap();
    mapCtrl.clear();
    attachMap(inlineHost);
    mapCtrl.syncZoom();
    ready = true;

    themeObserver = new MutationObserver(() => {
      mapCtrl?.setTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  });

  $effect(() => {
    liveData.lat = lat;
    liveData.lon = lon;
    liveData.hasGps = hasGps;
    liveData.links = links;
  });

  $effect(() => {
    ready;
    links;
    lat;
    lon;
    hasGps;
    if (!ready || !mapCtrl) return;
    const nodeKey = `${lat},${lon}`;
    const newNode = nodeKey !== lastNodeKey;
    if (newNode) {
      lastNodeKey = nodeKey;
      lastNeighborFit = 0;
      mapCtrl.clear();
    }
    const neighborsVisible = untrack(() => showNeighbors);
    mapCtrl.draw({ fitView: false });
    if (newNode) mapCtrl.fitGroupIfNeeded();
    mapCtrl.setNeighborsVisible(neighborsVisible);
    const neighborCount = links.filter(linkHasLocation).length;
    if (neighborCount > 0 && neighborCount !== lastNeighborFit && neighborsVisible) {
      mapCtrl.fitGroupIfNeeded();
      lastNeighborFit = neighborCount;
    }
    if (neighborCount === 0) lastNeighborFit = 0;
  });

  $effect(() => {
    if (!ready || !mapCtrl) return;
    if (modalOpen && modalHost) attachMap(modalHost);
    else if (!modalOpen && inlineHost) attachMap(inlineHost);
  });

  onDestroy(() => {
    themeObserver?.disconnect();
    mapCtrl?.clear();
    lastNodeKey = '';
    lastNeighborFit = 0;
    liveData.lat = 0;
    liveData.lon = 0;
    liveData.hasGps = false;
    liveData.links = [];
    detachMap();
    ui.onHoverTip = null;
    ui.onZoom = null;
    ui.onFocusHome = null;
    ui.closeModal = null;
  });
</script>

<div class="relative">
  <div bind:this={inlineHost} class="nm-map-host h-80 w-full rounded-xl overflow-hidden border border-edge"></div>

  {#if ready && !modalOpen}
    <div class="absolute top-2.5 right-2.5 z-10 flex items-start gap-2">
      {#if hasLocation && !zoomOn}
        <div
          class="nm-map-hint pointer-events-none rounded-md border border-edge bg-bg/70 px-2 py-0.5 text-[10px] text-dim backdrop-blur-sm"
        >
          Click to scroll-zoom
        </div>
      {/if}
      <div class="nm-map-tools flex flex-col overflow-hidden rounded-lg border border-edge">
      <button
        type="button"
        class="nm-tool-btn"
        title="Expand map"
        aria-label="Expand map"
        onclick={() => {
          mapCtrl?.enableZoom();
          modalOpen = true;
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      </button>
      {#if hasNeighborLocations}
        <button
          type="button"
          class="nm-tool-btn"
          class:nm-neighbors-off={!showNeighbors}
          title={showNeighbors ? 'Hide neighbors' : 'Show neighbors'}
          aria-label={showNeighbors ? 'Hide neighbors' : 'Show neighbors'}
          aria-pressed={showNeighbors}
          onclick={() => {
            mapCtrl?.enableZoom();
            toggleNeighbors();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
      {/if}
      </div>
    </div>
  {/if}

  {#if mapHover && !modalOpen}
    {@const tip = tipFields(mapHover.link)}
    <div
      class="nm-float-tip pointer-events-none absolute z-[700] max-w-[min(16rem,calc(100%-1rem))]"
      style:left="{mapHover.x}px"
      style:top="{mapHover.y}px"
      style:transform="translate(-50%, {mapHover.below ? '14px' : 'calc(-100% - 14px)'})"
    >
      <div class="nm-tip-name">{tip.name}</div>
      <div class="nm-tip-sub">{tip.sub1}</div>
      <div class="nm-tip-sub">{tip.sub2}</div>
    </div>
  {/if}
  {#if !hasLocation}
    <div class="absolute inset-0 z-[500] flex items-center justify-center pointer-events-none">
      <span class="rounded-md border border-edge bg-bg/80 px-3 py-1 text-xs text-dim">
        This node doesn’t send coordinates
      </span>
    </div>
  {/if}
</div>

<Dialog.Root bind:open={modalOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 h-[86vh] w-[92vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-edge bg-bg shadow-2xl"
    >
      <Dialog.Title class="sr-only">Node map</Dialog.Title>
      <div class="relative h-full w-full">
        <div bind:this={modalHost} class="nm-map-host h-full w-full"></div>

        <div class="absolute top-2.5 right-2.5 z-10 flex items-start gap-2">
          {#if hasLocation && !zoomOn}
            <div
              class="nm-map-hint pointer-events-none rounded-md border border-edge bg-bg/70 px-2 py-0.5 text-[10px] text-dim backdrop-blur-sm"
            >
              Click to scroll-zoom
            </div>
          {/if}
          <div class="nm-map-tools flex flex-col overflow-hidden rounded-lg border border-edge">
            {#if hasNeighborLocations}
              <button
                type="button"
                class="nm-tool-btn"
                class:nm-neighbors-off={!showNeighbors}
                title={showNeighbors ? 'Hide neighbors' : 'Show neighbors'}
                aria-label={showNeighbors ? 'Hide neighbors' : 'Show neighbors'}
                aria-pressed={showNeighbors}
                onclick={() => {
                  mapCtrl?.enableZoom();
                  toggleNeighbors();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              </button>
            {/if}
            <Dialog.Close class="nm-tool-btn" aria-label="Close map">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </Dialog.Close>
          </div>
        </div>

        {#if mapHover && modalOpen}
          {@const tip = tipFields(mapHover.link)}
          <div
            class="nm-float-tip pointer-events-none absolute z-[700] max-w-[min(16rem,calc(100%-1rem))]"
            style:left="{mapHover.x}px"
            style:top="{mapHover.y}px"
            style:transform="translate(-50%, {mapHover.below ? '14px' : 'calc(-100% - 14px)'})"
          >
            <div class="nm-tip-name">{tip.name}</div>
            <div class="nm-tip-sub">{tip.sub1}</div>
            <div class="nm-tip-sub">{tip.sub2}</div>
          </div>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .nm-map-host {
    position: relative;
    isolation: isolate;
  }

  :global(.nm-map) {
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }

  :global(.nm-map .maplibregl-control-container) {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  :global(.nm-map .maplibregl-ctrl-top-left),
  :global(.nm-map .maplibregl-ctrl-bottom-right) {
    pointer-events: auto;
  }

  :global(.nm-map .maplibregl-ctrl-bottom-right) {
    bottom: 0;
    right: 0;
  }

  :global(.maplibregl-map:focus),
  :global(.maplibregl-canvas:focus),
  :global(.maplibregl-canvas-container:focus) {
    outline: none !important;
  }

  :global(.nm-map .maplibregl-ctrl-group) {
    background: var(--color-elev) !important;
    border: 1px solid var(--color-edge) !important;
    border-radius: 0.5rem !important;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.1) !important;
    backdrop-filter: none;
  }

  :global(.nm-map .maplibregl-ctrl-group button:hover) {
    background: var(--color-elev2) !important;
  }

  :global(.nm-map .maplibregl-ctrl-group button) {
    width: 30px;
    height: 30px;
  }

  .nm-map-tools,
  .nm-map-hint {
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);
  }

  .nm-tool-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: var(--color-elev);
    color: var(--color-ink);
    border: 0;
    border-bottom: 1px solid var(--color-edge);
    cursor: pointer;
  }

  .nm-tool-btn:last-child {
    border-bottom: 0;
  }

  .nm-tool-btn:hover,
  .nm-tool-btn:focus-visible {
    background: var(--color-elev2);
    color: var(--color-accent);
    outline: none;
  }

  .nm-tool-btn.nm-neighbors-off {
    opacity: 0.45;
  }

  :global(.nm-float-tip) {
    background: var(--color-elev2);
    border: 1px solid var(--color-edge);
    border-radius: 0.5rem;
    color: var(--color-ink);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
    padding: 5px 9px;
    font-size: 0.75rem;
    line-height: 1.2;
    white-space: nowrap;
  }

  :global(.nm-float-tip .nm-tip-name) {
    font-weight: 600;
  }

  :global(.nm-float-tip .nm-tip-sub) {
    color: var(--color-muted);
    font-size: 0.7rem;
    margin-top: 1px;
  }
</style>

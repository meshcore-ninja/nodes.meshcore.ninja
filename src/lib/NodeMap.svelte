<script>
  // Leaflet map for a node: standard light OpenStreetMap tiles, the node pinned,
  // and its observed neighbours drawn as points joined by lines whose width tracks
  // link activity (like the main map). Always renders — with no GPS it shows a
  // world view and a "no location" overlay.
  import { onMount, onDestroy } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';

  let { lat = 0, lon = 0, hasGps = false, links = [] } = $props();

  const LINK_COLOR = '#a855f7'; // purple, like the main map's selected-node links

  let el;
  let map;
  let overlay; // layer group holding markers + lines, cleared on redraw
  let tiles; // current basemap layer, swapped when the theme changes
  let themeObserver;
  let ready = $state(false);

  function validCoord(a, b) {
    return Number.isFinite(a) && Number.isFinite(b);
  }

  function setTiles() {
    if (!map) return;
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const variant = theme === 'light' ? 'light_all' : 'dark_all';
    const r = window.devicePixelRatio > 1 ? '@2x' : '';
    tiles?.remove();
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}${r}.png`, {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '© OpenStreetMap © CARTO'
    }).addTo(map);
  }

  function draw() {
    if (!map) return;
    overlay?.remove();
    overlay = L.layerGroup().addTo(map);
    const pts = [];
    const nodeHasLocation = hasGps && validCoord(lat, lon);

    if (nodeHasLocation) {
      pts.push([lat, lon]);
      // Line width is relative to packet count across this node's links, so the
      // busiest neighbour reads widest (like the main map).
      const located = links.filter((l) => {
        const n = l.neighbor;
        return n?.hasGps && validCoord(n.lat, n.lon);
      });
      const maxPkt = located.reduce((m, l) => Math.max(m, l.packetCount || 0), 0) || 1;

      for (const l of located) {
        const n = l.neighbor;
        const p = [n.lat, n.lon];
        pts.push(p);
        L.polyline([[lat, lon], p], {
          color: LINK_COLOR,
          weight: 1 + ((l.packetCount || 0) / maxPkt) * 7,
          opacity: 0.5
        })
          .bindTooltip(`${n.name || n.pubkey.slice(0, 8)} · ${(l.packetCount || 0).toLocaleString()} pkts`, {
            sticky: true
          })
          .addTo(overlay);
        L.circleMarker(p, {
          radius: 2.5,
          color: '#000',
          weight: 0.75,
          fillColor: LINK_COLOR,
          fillOpacity: 0.9
        }).addTo(overlay);
      }
      // The node itself, drawn last so it sits on top of the neighbour cluster.
      L.circleMarker([lat, lon], {
        radius: 7,
        color: '#000',
        weight: 1.5,
        fillColor: '#4dd0a7',
        fillOpacity: 1
      })
        .addTo(overlay)
        .bringToFront();
    }

    if (pts.length > 1) {
      map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 11, animate: false });
    } else if (nodeHasLocation) {
      map.setView([lat, lon], 6, { animate: false }); // lone node → continental view
    } else {
      map.setView([20, 0], 2, { animate: false }); // no GPS → world
    }
  }

  onMount(() => {
    map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, zoomAnimation: false,
      fadeAnimation: false });
    setTiles(); // CARTO raster tiles that follow the app theme
    ready = true;
    setTimeout(() => map?.invalidateSize(), 60);

    // Live-swap the basemap when the user toggles light/dark.
    themeObserver = new MutationObserver(setTiles);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });

  // Redraw whenever the data or readiness changes (links arrive after the node).
  $effect(() => {
    ready;
    links;
    lat;
    lon;
    hasGps;
    if (ready) draw();
  });

  const hasLocation = $derived(hasGps && validCoord(lat, lon));

  onDestroy(() => {
    themeObserver?.disconnect();
    map?.remove();
  });
</script>

<div class="relative">
  <div bind:this={el} class="h-72 w-full rounded-xl overflow-hidden border border-edge"></div>
  {#if !hasLocation}
    <div class="absolute inset-0 z-[500] flex items-center justify-center pointer-events-none">
      <span class="rounded-md border border-edge bg-bg/80 px-3 py-1 text-xs text-dim">
        No GPS location
      </span>
    </div>
  {/if}
</div>

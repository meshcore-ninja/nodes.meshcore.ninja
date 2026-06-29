// CARTO raster basemaps — same tile strategy as map.meshcore.ninja.

const isRetina = () => typeof window !== 'undefined' && window.devicePixelRatio > 1;

export function basemapTiles(theme) {
  const r = isRetina() ? '@2x' : '';
  if (theme === 'light') {
    return ['a', 'b', 'c', 'd'].map(
      (s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}${r}.png`
    );
  }
  return ['a', 'b', 'c', 'd'].map(
    (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}${r}.png`
  );
}

export function basemapAttribution() {
  return '© OpenStreetMap contributors © CARTO';
}

/** Minimal MapLibre style object for a theme-following CARTO raster basemap. */
export function basemapStyle(theme) {
  return {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: basemapTiles(theme),
        tileSize: 256,
        attribution: basemapAttribution()
      }
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'carto' }]
  };
}

export function currentTheme() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

// Reverse geocoding via Nominatim (OpenStreetMap). Results are cached and
// requests are throttled to respect the 1 req/s usage policy.

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const cache = new Map();
let lastFetchAt = 0;
const MIN_INTERVAL_MS = 1100;

function cacheKey(lat, lon) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

/** @param {any} data */
function parseNominatim(data) {
  const addr = data?.address;
  if (!addr) return null;
  const { city, town, village, municipality, county, state, country, country_code: countryCode } =
    addr;
  const locality = city ?? town ?? village ?? municipality ?? county ?? null;
  if (!locality && !country && !state) return null;
  return {
    locality,
    country: country ?? state ?? null,
    countryCode: countryCode ? String(countryCode).toUpperCase() : ''
  };
}

/**
 * @param {{ locality?: string | null, country?: string | null, countryCode?: string } | null} place
 * @returns {string}
 */
export function formatPlaceLabel(place) {
  if (!place) return 'Location unknown';
  const { locality, country, countryCode } = place;
  let label;
  if (locality && country && locality !== country) label = `${locality}, ${country}`;
  else if (locality) label = locality;
  else if (country) label = country;
  else return 'Location unknown';
  if (countryCode) label += ` (${countryCode})`;
  return label;
}

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ locality: string | null, country: string | null, countryCode: string } | null>}
 */
export async function reverseGeocode(lat, lon, signal) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key);

  await throttle();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const sp = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    'accept-language': 'en',
    zoom: '10'
  });
  const res = await fetch(`${NOMINATIM}?${sp}`, { signal, headers: { 'Accept-Language': 'en' } });
  if (!res.ok) return null;
  const place = parseNominatim(await res.json());
  cache.set(key, place);
  return place;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {{ pubkey?: string }} [opts]
 * @returns {{ value: string, label: string, url: string }[]}
 */
export function externalMapLinks(lat, lon, { pubkey } = {}) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return [];
  const links = [
    { value: 'google', label: 'Google Maps', url: `https://www.google.com/maps?q=${la},${lo}` },
    {
      value: 'osm',
      label: 'OpenStreetMap',
      url: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=15/${la}/${lo}`
    },
    { value: 'apple', label: 'Apple Maps', url: `https://maps.apple.com/?ll=${la},${lo}` },
    { value: 'bing', label: 'Bing Maps', url: `https://www.bing.com/maps?cp=${la}~${lo}&lvl=15` }
  ];
  if (pubkey) {
    links.push({
      value: 'meshcore',
      label: 'map.meshcore.ninja',
      url: `https://map.meshcore.ninja/?sel=${encodeURIComponent(pubkey)}`
    });
  }
  return links;
}

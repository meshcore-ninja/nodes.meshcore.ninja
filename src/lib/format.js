// Small display helpers shared across the directory pages. Node-type icons are
// rendered by NodeIcon.svelte (static Lucide SVGs); labels live here.

/** Node type → human label. */
export const TYPE_LABEL = { 0: 'unknown', 1: 'companion', 2: 'repeater', 3: 'room', 4: 'sensor' };

/** The selectable node types for the search filter, in display order. */
export const TYPE_OPTIONS = [
  { value: 2, label: 'Repeaters' },
  { value: 1, label: 'Companions' },
  { value: 3, label: 'Rooms' },
  { value: 4, label: 'Sensors' }
];

/** Absolute UTC timestamp, e.g. "2026-06-29 12:45:01". 0/empty → "—". */
export function fmtTime(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** Compact relative age, e.g. "now", "3m ago", "5h ago", "2d ago". 0 → "never". */
export function fmtAgo(unix, now = Date.now() / 1000) {
  if (!unix) return 'never';
  const s = Math.max(0, Math.floor(now - unix));
  if (s === 0) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Coordinates as a short "lat, lon" string, or "" when no GPS. */
export function fmtCoords(lat, lon) {
  if (lat == null || lon == null) return '';
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Shorten a 64-char pubkey for display: "5c0b46…e5fc40". */
export function shortKey(pubkey) {
  if (!pubkey || pubkey.length <= 14) return pubkey || '';
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`;
}

/** Less aggressive shorten for tight layouts: "5c0b46ab12cd…e5fc40ab12cd". */
export function shortKeyWide(pubkey) {
  if (!pubkey || pubkey.length <= 34) return pubkey || '';
  return `${pubkey.slice(0, 16)}…${pubkey.slice(-16)}`;
}

/** First 8 hex chars of a pubkey, for very tight columns. */
export function shortKey8(pubkey) {
  if (!pubkey) return '';
  return pubkey.slice(0, 8);
}

/** ISO 3166-1 alpha-2 country code → flag emoji, e.g. "CZ" → 🇨🇿. "" if invalid. */
export function flagEmoji(cc) {
  if (!cc || cc.length !== 2 || !/^[a-zA-Z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + (up.charCodeAt(0) - 65), base + (up.charCodeAt(1) - 65));
}

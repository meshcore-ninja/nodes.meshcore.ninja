// Country flags via `country-flag-icons` (same source as meshcore.ninja), as
// inline SVG strings keyed by ISO 3166-1 alpha-2 code.
import * as countryFlags from 'country-flag-icons/string/3x2';

/** Inline 3:2 flag SVG for a country code, or null. Case-insensitive. */
export function countryFlagSvg(code) {
  if (!code) return null;
  return countryFlags[String(code).toUpperCase()] ?? null;
}

/**
 * The flags to show for a network catalog entry — one per coverage country
 * (e.g. CascadiaMesh → CA + US). Networks with no country coverage show none.
 * @returns {{ code: string, svg: string }[]}
 */
export function networkFlags(network) {
  return (network?.coverage?.countries ?? [])
    .map((code) => ({ code, svg: countryFlagSvg(code) }))
    .filter((f) => f.svg);
}

/** True when any of the network's radios maps to a MeshCore app preset. */
export function isAppPresetNetwork(network) {
  const radios = Array.isArray(network?.radios) ? network.radios : network?.radio ? [network.radio] : [];
  return radios.some((r) => r?.app_preset);
}

/** Catalog URL for a network on meshcore.ninja. */
export function networkUrl(id) {
  return `https://meshcore.ninja/network/${encodeURIComponent(id)}`;
}

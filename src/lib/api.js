// Client for the MeshCore Ninja API, scoped to what the node directory needs:
// search, single-node detail, and per-node advert history. Callers thread an
// AbortSignal so a new request (e.g. the next keystroke) cancels the previous.

export const API_BASE = (import.meta.env?.VITE_API_BASE || 'https://api.meshcore.ninja').replace(
  /\/+$/,
  ''
);

/**
 * Search the node directory. Includes nodes without GPS, unlike the map.
 * @param {object} p
 * @param {string} [p.q] name substring (case-insensitive) or pubkey hex prefix
 * @param {number[]} [p.types] node types: 1=chat 2=repeater 3=room 4=sensor
 * @param {string} [p.net] restrict to a network id
 * @param {string} [p.active] one of 24h|7d|30d (omit/`all` = any age)
 * @param {number} [p.limit]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{results:any[],returned:number,total:number,capped:boolean}>}
 */
export function search({ q, types, net, active, limit } = {}, signal) {
  const sp = new URLSearchParams();
  if (q) sp.set('q', q);
  if (types?.length) sp.set('types', [...types].sort().join(','));
  if (net) sp.set('networks', net);
  if (active && active !== 'all') sp.set('active', active);
  if (limit) sp.set('limit', String(limit));
  return fetch(`${API_BASE}/api/search?${sp.toString()}`, { signal }).then((r) => {
    if (!r.ok) throw new Error(`search ${r.status}`);
    return r.json();
  });
}

/**
 * One node's overview row plus its rolling latest-adverts list.
 * @param {string} pubkey hex public key
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>} the node view, or null if unknown
 */
export function nodeDetail(pubkey, signal) {
  return fetch(`${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}`, { signal }).then((r) => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`node ${r.status}`);
    return r.json();
  });
}

/**
 * One page of a node's full advert history, newest first. Pass the previous
 * page's `nextBefore` as `before` to fetch older adverts (keyset pagination).
 * @param {string} pubkey hex public key
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.before] cursor from the previous page's nextBefore
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,adverts:any[],returned:number,hasMore:boolean,nextBefore?:number}>}
 */
export function nodeAdverts(pubkey, { limit, before } = {}, signal) {
  const sp = new URLSearchParams();
  if (limit) sp.set('limit', String(limit));
  if (before) sp.set('before', String(before));
  const qs = sp.toString();
  const url = `${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/adverts${qs ? `?${qs}` : ''}`;
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`adverts ${r.status}`);
    return r.json();
  });
}

/**
 * Observed links (neighbours) for one node, already aggregated by the API. Only
 * links with this node as an endpoint are returned. Sorted by recent activity.
 * @param {string} pubkey hex public key
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,links:any[],returned:number,total:number,capped:boolean}>}
 */
export function nodeLinks(pubkey, { limit } = {}, signal) {
  const sp = new URLSearchParams();
  if (limit) sp.set('limit', String(limit));
  const qs = sp.toString();
  const url = `${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/links${qs ? `?${qs}` : ''}`;
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`links ${r.status}`);
    return r.json();
  });
}

/**
 * One node's per-network advert activity (count + first/last advert time per
 * network), newest-active first. Aggregated server-side from the advert history.
 * @param {string} pubkey hex public key
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,networks:{networkId:string,adverts:number,firstAt:number,lastAt:number}[]}>}
 */
export function nodeNetworkStats(pubkey, signal) {
  return fetch(`${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/networks`, { signal }).then(
    (r) => {
      if (!r.ok) throw new Error(`networks ${r.status}`);
      return r.json();
    }
  );
}

// Origin of the MeshCore Ninja catalog that publishes networks.json (network
// metadata). Overridable for local testing.
const CATALOG_ORIGIN = (import.meta.env?.VITE_CATALOG_ORIGIN || 'https://meshcore.ninja').replace(
  /\/+$/,
  ''
);

let meshNetworksPromise;
/**
 * The network catalog from the site's networks.json (a flat array of networks),
 * keyed by network id, so a profile can show flag + details for each network a
 * node was heard on. Fetched once and memoized; failures resolve to an empty map.
 * @returns {Promise<Record<string, any>>}
 */
export function meshNetworks() {
  if (!meshNetworksPromise) {
    meshNetworksPromise = fetch(`${CATALOG_ORIGIN}/networks.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => Object.fromEntries((Array.isArray(list) ? list : []).map((n) => [n.id, n])))
      .catch(() => ({}));
  }
  return meshNetworksPromise;
}

let networksPromise;
/**
 * The network list (id + name), used to label the network filter. Fetched once
 * and memoized; failures resolve to an empty list so the filter just hides.
 * @returns {Promise<{id:string,name:string}[]>}
 */
export function networks() {
  if (!networksPromise) {
    networksPromise = fetch(`${API_BASE}/api/networks`)
      .then((r) => (r.ok ? r.json() : { networks: [] }))
      .then((d) => (d.networks ?? []).map((n) => ({ id: n.id, name: n.name })))
      .then((list) => list.sort((a, b) => a.name.localeCompare(b.name)))
      .catch(() => []);
  }
  return networksPromise;
}

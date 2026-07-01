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
 * @param {{key:string,value:string,radiusKm?:number}[]} [p.filters] structured search filters
 * @param {number} [p.limit]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{results:any[],returned:number,total:number,capped:boolean,computeMs?:number,apiMs?:number}>}
 */
export function search({ q, types, net, active, filters, limit } = {}, signal) {
  const sp = new URLSearchParams();
  if (q) sp.set('q', q);
  if (types?.length) sp.set('types', [...types].sort().join(','));
  if (net) sp.set('networks', net);
  if (active && active !== 'all') sp.set('active', active);
  for (const f of filters ?? []) {
    if (!f?.key || f.value == null || f.value === '') continue;
    sp.append(f.key, String(f.value));
    if (f.key === 'near' && f.radiusKm) sp.set('radius', String(f.radiusKm));
  }
  if (limit) sp.set('limit', String(limit));
  const started = performance.now();
  return fetch(`${API_BASE}/api/search?${sp.toString()}`, { signal }).then((r) => {
    if (!r.ok) throw new Error(`search ${r.status}`);
    return r.json().then((body) => ({
      ...body,
      apiMs: Math.max(0, performance.now() - started - (body.computeMs || 0))
    }));
  });
}

/**
 * Directory-wide aggregate stats. This replaces several count-only search
 * requests with one API call.
 * @param {AbortSignal} [signal]
 * @returns {Promise<any|null>}
 */
export function directoryStats(signal) {
  return fetch(`${API_BASE}/api/stats`, { signal })
    .then((r) => {
      if (!r.ok) throw new Error(`stats ${r.status}`);
      return r.json();
    })
    .catch(() => null);
}

export function directoryOverviewRows(stats) {
  const d = stats?.directory;
  if (!d) return [];
  return [
    { group: 'Source', label: 'Signed adverts', value: d.sources?.advert },
    { group: 'Source', label: 'Unsigned map', value: d.sources?.map },
    { group: 'Source', label: 'CoreScope', value: d.sources?.corescope },
    { group: 'Type', label: 'Repeaters', value: d.types?.repeater },
    { group: 'Type', label: 'Companions', value: d.types?.companion },
    { group: 'Type', label: 'Rooms', value: d.types?.room },
    { group: 'Type', label: 'Sensors', value: d.types?.sensor },
    { group: 'Freshness', label: 'Last 24h', value: d.freshness?.last24h },
    { group: 'Freshness', label: 'Last 7d', value: d.freshness?.last7d },
    { group: 'Freshness', label: 'Older than 30d', value: d.freshness?.olderThan30d },
    { group: 'Data', label: 'With location', value: d.data?.withLocation },
    { group: 'Data', label: 'With name', value: d.data?.withName }
  ];
}

// The API's live advert WebSocket. Each frame is one observed advert carrying a
// `new` flag — true the first time a node is ever seen — so the client can grow
// the node count in realtime. Derived from API_BASE unless overridden.
export const API_LIVE_WS = (
  import.meta.env?.VITE_API_LIVE_WS ||
  `${API_BASE.replace(/^http/, 'ws')}/api/live`
).replace(/\/+$/, '');

/**
 * Subscribe to first-ever node sightings on the live feed. `onNew` is called
 * (with the advert) each time a brand-new node appears, so callers can tick a
 * running count up in realtime. Returns a stop() that closes the socket and
 * cancels reconnection.
 * @param {(advert:any)=>void} onNew
 * @returns {() => void}
 */
export function watchNewNodes(onNew) {
  let ws;
  let timer;
  let stopped = false;
  let backoff = 1000;

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(API_LIVE_WS);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      backoff = 1000;
    };
    ws.onmessage = (ev) => {
      let f;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (f?.new && f.pubkey) onNew(f);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!stopped) schedule();
    };
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

/**
 * The most recently discovered nodes (newest first-ever advert). The API has no
 * first-seen sort, but every observed-node result carries `firstAdvertAt`, and a
 * freshly-discovered node has just adverted — so it's always near the top of the
 * recently-active set. We pull the live (`source=advert`) nodes and sort them by
 * first-seen client-side. Map-only entries are excluded (they carry no
 * first-advert time).
 * @param {number} [limit] how many newest nodes to return
 * @param {AbortSignal} [signal]
 * @returns {Promise<any[]>}
 */
export function newestNodes(limit = 8, signal) {
  return search({ filters: [{ key: 'source', value: 'advert' }], limit: 150 }, signal).then((d) =>
    (d.results ?? [])
      .filter((n) => n.firstAdvertAt > 0)
      .sort((a, b) => b.firstAdvertAt - a.firstAdvertAt)
      .slice(0, limit)
  );
}

let searchOptionsPromise;
export function searchOptions(signal) {
  if (!searchOptionsPromise || signal) {
    searchOptionsPromise = fetch(`${API_BASE}/api/search/options`, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`search options ${r.status}`);
        return r.json();
      })
      .catch(() => ({ commands: [] }));
  }
  return searchOptionsPromise;
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

/**
 * One node's daily advert activity for a contribution-style heatmap.
 * @param {string} pubkey hex public key
 * @param {object} [opts]
 * @param {number} [opts.days]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,days:number,from:number,to:number,activity:{day:number,adverts:number}[]}>}
 */
export function nodeAdvertActivity(pubkey, { days } = {}, signal) {
  const sp = new URLSearchParams();
  if (days) sp.set('days', String(days));
  const qs = sp.toString();
  const url = `${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/activity${qs ? `?${qs}` : ''}`;
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`activity ${r.status}`);
    return r.json();
  });
}

/**
 * One node's captured map.meshcore.io publish history, newest publish first.
 * Each entry is a distinct snapshot of the node's directory metadata we have
 * mirrored over time. Empty when the node has never appeared on the map.
 * @param {string} pubkey hex public key
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,publishes:any[]}>}
 */
export function nodeMapPublishes(pubkey, signal) {
  return fetch(`${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/map`, { signal }).then((r) => {
    if (!r.ok) throw new Error(`map ${r.status}`);
    return r.json();
  });
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

let bandsPromise;
/**
 * The LoRa band catalog from the site's bands.json, keyed by band id (e.g. "868",
 * "915"), each `{name, range, region}`. Used to render a node's Band badge.
 * Fetched once and memoized; failures resolve to an empty map.
 * @returns {Promise<Record<string, {name:string,range:string,region:string}>>}
 */
export function bands() {
  if (!bandsPromise) {
    bandsPromise = fetch(`${CATALOG_ORIGIN}/bands.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => (d && typeof d === 'object' ? d : {}))
      .catch(() => ({}));
  }
  return bandsPromise;
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

// Shared, ref-counted view of brand-new nodes as they're first observed on the
// API's live feed. A single `/api/live` socket is opened lazily when the first
// subscriber attaches and closed when the last detaches, so the homepage count
// and the live-advert highlight share one connection.
//
// `newNodeKeys` is a reactive set of pubkeys seen for the very first time this
// session; entries auto-expire after a short window so a node isn't flagged
// "new" forever as it keeps re-advertising.
import { SvelteSet } from 'svelte/reactivity';
import { watchNewNodes } from './api.js';

export const newNodeKeys = new SvelteSet();

const HIGHLIGHT_MS = 90_000; // how long a first-seen node stays flagged "new"

let stop = null;
let refs = 0;
let listeners = [];
const expiries = new Map(); // pubkey → timeout id

function ensure() {
  if (stop) return;
  stop = watchNewNodes((advert) => {
    const key = advert.pubkey;
    newNodeKeys.add(key);
    // Refresh the expiry if it re-fires within the window.
    clearTimeout(expiries.get(key));
    expiries.set(
      key,
      setTimeout(() => {
        newNodeKeys.delete(key);
        expiries.delete(key);
      }, HIGHLIGHT_MS)
    );
    for (const cb of listeners) cb(advert);
  });
}

function teardown() {
  stop?.();
  stop = null;
  for (const id of expiries.values()) clearTimeout(id);
  expiries.clear();
  newNodeKeys.clear();
}

/**
 * Attach to the live new-node feed. Pass `onNew` to be called for every
 * first-seen node (e.g. to tick a counter), or omit it just to keep the shared
 * socket alive while a component that reads `newNodeKeys` is mounted. Returns a
 * detach function; the socket closes once every subscriber has detached.
 * @param {(advert:any)=>void} [onNew]
 * @returns {() => void}
 */
export function onNewNode(onNew) {
  ensure();
  refs++;
  if (onNew) listeners.push(onNew);
  return () => {
    if (onNew) listeners = listeners.filter((cb) => cb !== onNew);
    refs = Math.max(0, refs - 1);
    if (refs === 0) teardown();
  };
}

import { writable } from 'svelte/store';

/** Bump to request focus on the homepage search input (when already on /). */
export const focusSearchInput = writable(0);

/** True on Apple platforms — used for the ⌘ vs Ctrl shortcut hint. */
export function isMacPlatform() {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(ua);
}

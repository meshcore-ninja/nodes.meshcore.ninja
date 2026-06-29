// Pure client-rendered SPA: the API is queried in the browser, and the dynamic
// /node/[pubkey] profiles can't be prerendered, so SSR/prerender are off and the
// adapter's fallback (404.html) serves deep links on GitHub Pages.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'ignore';

import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // SPA: prerender the shell and let the client render every route, including
    // the dynamic /node/[pubkey] profiles. The fallback serves deep links.
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      // SPA fallback for unmatched paths. GitHub Pages serves `404.html` (with
      // an HTTP 404) for any URL that isn't a prerendered file; this shell boots
      // the client router for deep links like /{pubkey}.
      fallback: '404.html',
      precompress: false,
      strict: false
    }),
    paths: {
      base: process.env.BASE_PATH ?? ''
    }
  }
};

export default config;

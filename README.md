# nodes.meshcore.ninja

A searchable public directory of **MeshCore nodes**, built from observed signed
adverts. One search box finds nodes by name or public key (and filters by type
and recency); every node has a permanent profile showing its current advert,
public key, first/last seen, previous names/locations/types, and its complete
advert history with decoded fields.

It's a static SPA (SvelteKit + Tailwind, `adapter-static`) that reads everything
live from the [MeshCore Ninja API](../meshcore-ninja/api) — the same backend
behind [map.meshcore.ninja](https://map.meshcore.ninja).

## Develop

```bash
npm install
cp .env.example .env.local   # point VITE_API_BASE at your API
npm run dev
```

`VITE_API_BASE` is the API origin (default `https://api.meshcore.ninja`). For a
local API, set it to e.g. `http://localhost:8080` in `.env.local`.

```bash
npm run build     # static site → build/
npm run preview   # preview the production build
```

## Deploy

Production is a static SPA on **GitHub Pages** at
[nodes.meshcore.ninja](https://nodes.meshcore.ninja), deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to
`main` (or manually via **Actions → Test & Deploy → Run workflow**).

Before the first deploy, enable **Settings → Pages → Build and deployment →
GitHub Actions** on the repo. The workflow builds with `adapter-static`, sets
`BASE_PATH` from `actions/configure-pages` (empty when serving from the custom
domain in `static/CNAME`), and uploads the `build/` artifact.

To preview a project-site subpath locally:

```bash
BASE_PATH=/nodes.meshcore.ninja npm run build && npm run preview
```

## API endpoints used

The directory relies on three read endpoints (added to the API for this app, see
[`../meshcore-ninja/api`](../meshcore-ninja/api)):

| endpoint | purpose |
|----------|---------|
| `GET /api/search?q=&types=&active=&networks=&limit=` | directory search. Unlike `/api/map` it **includes nodes without GPS**, so every observed node is findable. Ranked by relevance (exact/prefix name, then pubkey prefix, then substring) and recency. Returns lightweight rows (no per-node advert list). |
| `GET /api/nodes/{pubkey}` | one node's overview row + its rolling latest-adverts list — the profile's primary fetch (avoids the multi-MB `/api/nodes` dump). |
| `GET /api/nodes/{pubkey}/adverts?limit=&before=` | the node's **full advert history** from the append-only history table, newest first, keyset-paginated (`before` = the previous page's `nextBefore`). |

## Pages

- **`/`** — minimalistic homepage: a dominant search input with type/recency
  filters. Query state is mirrored to the URL (`?q=&types=&active=`) so a result
  page is shareable. Results link to profiles.
- **`/{pubkey}`** — permanent node profile: identity + type + networks,
  copyable public key, first/last seen, advert count, location (+ map link),
  history-derived "previous names / types / locations", and the paginated advert
  history table.

## Notes / future work

- "Previous names/types/locations" are derived client-side from the advert
  history pages that have been loaded.
- Raw packet bytes and signature validity are **not** surfaced yet — the API
  stores decoded advert fields but not the raw wire bytes or a verified-signature
  flag. Adding those would mean persisting `raw_hex` (and a `meshpkt`
  `VerifyAdvert` result) at ingest.

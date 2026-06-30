<script>
  // A small box of the most recently discovered nodes (newest first-ever advert
  // across the mesh). Refreshed on a slow interval so freshly-onboarded nodes
  // surface here without the user having to catch them flying past in the live
  // feed. Each row links to the node's profile.
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import NetworkPill from '$lib/NetworkPill.svelte';
  import { meshNetworks, newestNodes } from '$lib/api.js';
  import { TYPE_LABEL, fmtAgo, shortKey } from '$lib/format.js';

  let catalog = $state({});
  meshNetworks().then((c) => (catalog = c));

  let nodes = $state([]);
  let loaded = $state(false);
  let now = $state(Date.now() / 1000);

  async function refresh() {
    try {
      nodes = await newestNodes(8);
    } catch {
      /* keep the last good list on a transient failure */
    }
    loaded = true;
  }

  onMount(() => {
    refresh();
    const reload = setInterval(refresh, 60000);
    const tick = setInterval(() => (now = Date.now() / 1000), 1000);
    return () => {
      clearInterval(reload);
      clearInterval(tick);
    };
  });
</script>

<section class="mt-10" aria-label="Newest nodes">
  <div class="mb-3 flex items-center gap-2 text-sm font-medium text-dim">
    <span class="text-accent" aria-hidden="true">✦</span>
    Newest nodes
    <span class="text-muted">· freshly discovered</span>
  </div>

  {#if loaded && nodes.length}
    <ul class="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-gradient-to-b from-accent/5 to-transparent">
      {#each nodes as n (n.pubkey)}
        <li>
          <a
            href="{base}/{n.pubkey}"
            class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elev"
          >
            <NodeIcon type={n.type} size={18} class="shrink-0 text-dim" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate font-medium">{n.name || '(unnamed)'}</span>
                <span class="shrink-0 text-xs capitalize text-muted">{TYPE_LABEL[n.type]}</span>
              </span>
              <span class="flex items-center gap-2">
                <span class="shrink-0 font-mono text-xs text-muted">{shortKey(n.pubkey)}</span>
                {#each n.networks ?? [] as net}
                  <NetworkPill id={net} {catalog} />
                {/each}
              </span>
            </span>
            <span
              class="shrink-0 whitespace-nowrap text-xs text-accent/90 tabular-nums"
              title="First time this node was ever observed"
            >
              first seen {fmtAgo(n.firstAdvertAt, now)}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {:else if loaded}
    <div class="rounded-xl border border-edge bg-elev/40 px-4 py-6 text-center text-sm text-muted">
      No newly discovered nodes right now.
    </div>
  {:else}
    <div class="rounded-xl border border-edge bg-elev/40 px-4 py-6 text-center text-sm text-muted">
      Looking for the newest nodes…
    </div>
  {/if}
</section>

<script>
  import { tick } from 'svelte';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { Command, Dialog } from 'bits-ui';
  import Search from '@lucide/svelte/icons/search';
  import { search } from '$lib/api.js';
  import NodeIcon from '$lib/NodeIcon.svelte';
  import { TYPE_LABEL, fmtAgo, shortKey } from '$lib/format.js';

  let { open = $bindable(false) } = $props();

  let query = $state('');
  let results = $state([]);
  let loading = $state(false);
  let error = $state('');
  let inflight;
  let debounce;

  $effect(() => {
    if (open) query = '';
  });

  $effect(() => {
    const q = query.trim();
    if (!open) return;
    clearTimeout(debounce);
    if (!q) {
      results = [];
      loading = false;
      error = '';
      inflight?.abort();
      return;
    }
    debounce = setTimeout(() => runSearch(q), 200);
    return () => clearTimeout(debounce);
  });

  async function runSearch(q) {
    inflight?.abort();
    inflight = new AbortController();
    loading = true;
    error = '';
    try {
      const d = await search({ q, limit: 20 }, inflight.signal);
      results = d.results ?? [];
    } catch (e) {
      if (e.name !== 'AbortError') {
        error = 'Search failed. Is the API reachable?';
        results = [];
      }
    } finally {
      loading = false;
    }
  }

  async function go(node) {
    if (!node) return;
    open = false;
    await tick();
    goto(`${base}/${node.pubkey}`);
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => (open = v)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl border border-edge bg-elev shadow-2xl outline-none"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <Dialog.Title class="sr-only">Search nodes</Dialog.Title>

      <Command.Root shouldFilter={false} loop label="Search nodes">
        <div class="flex items-center gap-3 border-b border-edge px-4">
          <Search class="size-4 shrink-0 text-dim" />
          <Command.Input
            bind:value={query}
            placeholder="Search by name or public key…"
            autofocus
            class="w-full bg-transparent py-3.5 text-base outline-none placeholder:text-muted"
          />
          <Dialog.Close
            class="rounded border border-edge px-1.5 py-0.5 text-[0.7rem] text-dim hover:text-ink"
          >
            esc
          </Dialog.Close>
        </div>

        <Command.List class="max-h-[60vh] overflow-y-auto">
          <Command.Viewport>
            {#if !query.trim()}
              <p class="px-4 py-8 text-center text-sm text-dim">
                Search by node name or public key prefix
              </p>
            {:else if loading && !results.length}
              <p class="px-4 py-8 text-center text-sm text-dim">Searching…</p>
            {:else if error}
              <p class="px-4 py-8 text-center text-sm text-bad">{error}</p>
            {:else if !results.length}
              <Command.Empty class="px-4 py-8 text-center text-sm text-dim">
                No nodes match “{query.trim()}”
              </Command.Empty>
            {/if}

            <div class="py-1.5">
              {#each results as node (node.pubkey)}
                <Command.Item
                  value={node.pubkey}
                  onSelect={() => go(node)}
                  class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left outline-none data-[selected]:bg-elev2"
                >
                  <NodeIcon type={node.type} size={18} class="shrink-0 text-dim" />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="truncate text-[0.95rem] text-ink">{node.name || '(unnamed)'}</span>
                      {#if node.source === 'map'}
                        <span
                          class="shrink-0 rounded-full border border-accent2/40 px-1.5 py-px text-[0.6rem] uppercase tracking-wide text-accent2"
                          title="Only on map.meshcore.io — not yet observed by our analyzers"
                        >
                          map
                        </span>
                      {/if}
                    </span>
                    <span class="block truncate font-mono text-xs text-muted">{shortKey(node.pubkey)}</span>
                  </span>
                  <span class="shrink-0 text-right text-xs text-dim">
                    <span class="block capitalize">{TYPE_LABEL[node.type]}</span>
                    <span class="block">{fmtAgo(node.lastAdvertAt)}</span>
                  </span>
                </Command.Item>
              {/each}
            </div>
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

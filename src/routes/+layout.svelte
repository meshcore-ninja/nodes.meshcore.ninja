<script>
  import { onMount } from 'svelte';
  import '../app.css';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Tooltip } from 'bits-ui';
  import { directoryOverviewRows, directoryStats } from '$lib/api.js';
  import { onNewNode } from '$lib/newNodes.js';
  import { focusSearchInput } from '$lib/search.js';
  import ShortcutHint from '$lib/ShortcutHint.svelte';
  import RollingNumber from '$lib/RollingNumber.svelte';

  let { children } = $props();

  let theme = $state('dark');
  let totalNodes = $state(null);
  let nodeOverview = $state([]);
  let nodeOverviewLoading = $state(false);
  $effect(() => {
    theme = document.documentElement.getAttribute('data-theme') || 'dark';
  });
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      /* ignore */
    }
  }

  // The homepage is its own hero; deeper pages get the compact top bar.
  const isHome = $derived($page.url.pathname === base + '/' || $page.url.pathname === base);

  function openSearch() {
    if (isHome) {
      focusSearchInput.update((n) => n + 1);
      return;
    }
    goto(`${base}/?focus=search`);
  }

  function onkeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  }

  async function refreshNodeOverview() {
    nodeOverviewLoading = true;
    try {
      const stats = await directoryStats();
      totalNodes = stats?.directory?.total ?? stats?.nodes?.total ?? totalNodes;
      nodeOverview = directoryOverviewRows(stats);
    } catch {
      nodeOverview = [];
    } finally {
      nodeOverviewLoading = false;
    }
  }

  onMount(() => {
    const refreshStats = async () => {
      await refreshNodeOverview();
    };
    refreshStats();
    const countTimer = setInterval(refreshStats, 30000);
    const stopWatch = onNewNode(() => {
      if (totalNodes != null) totalNodes += 1;
    });
    return () => {
      clearInterval(countTimer);
      stopWatch();
    };
  });
</script>

{#snippet nodeCountTooltip()}
  <Tooltip.Portal>
    <Tooltip.Content
      side="bottom"
      sideOffset={8}
      class="z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-edge bg-elev2 px-3 py-3 text-xs text-ink shadow-lg shadow-black/30"
    >
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <div class="font-semibold">Directory overview</div>
        {#if totalNodes != null}
          <div class="font-mono text-muted">{totalNodes.toLocaleString()} total</div>
        {/if}
      </div>
      {#if nodeOverviewLoading && !nodeOverview.length}
        <div class="space-y-1.5">
          {#each [1, 2, 3, 4, 5] as _}
            <div class="h-3 animate-pulse rounded bg-edge/70"></div>
          {/each}
        </div>
      {:else if nodeOverview.length}
        <table class="w-full border-separate border-spacing-0 overflow-hidden rounded border border-edge/80 text-left">
          <tbody>
            {#each nodeOverview as row, i (`${row.group}-${row.label}`)}
              <tr class={i % 2 ? 'bg-bg/40' : 'bg-bg/70'}>
                <td class="w-20 px-2 py-1 text-[10px] uppercase tracking-wide text-muted">{row.group}</td>
                <td class="px-2 py-1 text-dim">{row.label}</td>
                <td class="px-2 py-1 text-right font-mono text-ink">
                  {row.value == null ? '—' : row.value.toLocaleString()}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="mt-2 text-[11px] leading-relaxed text-muted">
          Rows overlap: a node can be counted by source, type, freshness, and data completeness.
        </p>
      {:else}
        <p class="text-muted">{nodeOverviewLoading ? 'Loading overview…' : 'Overview is not available right now.'}</p>
      {/if}
      <Tooltip.Arrow class="text-edge" />
    </Tooltip.Content>
  </Tooltip.Portal>
{/snippet}

<svelte:window {onkeydown} />

<div class="min-h-screen flex flex-col">
  {#if !isHome}
    <header class="border-b border-edge">
      <div class="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-4 min-w-0">
        <div class="flex items-center gap-3 min-w-0">
          <a href="{base}/" class="font-semibold tracking-tight flex items-center gap-2 min-w-0 shrink-0">
            <span class="text-accent shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-dot-icon lucide-circle-dot"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/></svg></span>
            <span class="truncate">nodes.meshcore.ninja</span>
          </a>
          <button
            type="button"
            onclick={openSearch}
            aria-label="Search nodes"
            class="flex shrink-0 cursor-pointer items-center gap-2 rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-dim hover:border-accent hover:text-ink"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" stroke-linecap="round" />
            </svg>
            <span class="hidden text-xs sm:inline"><ShortcutHint /></span>
          </button>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          {#if totalNodes != null}
            <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
              <Tooltip.Root>
                <Tooltip.Trigger
                  class="hidden items-center gap-1.5 rounded-md border border-edge bg-bg px-2.5 py-1.5 text-xs text-dim outline-none hover:border-accent hover:text-ink focus-visible:ring-1 focus-visible:ring-accent sm:inline-flex"
                >
                  <span class="font-semibold text-ink"><RollingNumber value={totalNodes} /></span>
                  <span>nodes</span>
                </Tooltip.Trigger>
                {@render nodeCountTooltip()}
              </Tooltip.Root>
            </Tooltip.Provider>
          {/if}
          <button
            type="button"
            onclick={toggleTheme}
            class="shrink-0 cursor-pointer rounded-md border border-edge bg-bg px-2 py-1 text-sm text-dim hover:border-accent hover:text-ink"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </div>
    </header>
  {:else}
    <!-- Homepage has no top bar, so float the theme toggle in the corner. -->
    <button
      type="button"
      onclick={toggleTheme}
      class="absolute top-4 right-4 z-10 cursor-pointer rounded-md border border-edge bg-bg px-2 py-1 text-sm text-dim hover:border-accent hover:text-ink"
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  {/if}

  <main class="flex-1 flex flex-col min-w-0 pb-12">
    {@render children?.()}
  </main>

  <footer class="border-t border-edge text-dim text-xs">
    <div class="mx-auto max-w-6xl px-4 py-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <span class="text-center sm:text-left">
        Powered by
        <a class="foot-link" href="https://tangleveil.meshcore.ninja/" target="_blank" rel="noreferrer">⋈ Tangleveil</a>
        ·
        <a class="foot-link" href="https://github.com/meshcore-ninja/nodes.meshcore.ninja" target="_blank" rel="noreferrer">source code</a>
      </span>
      <div class="flex items-center justify-center gap-4 sm:justify-end">
        <a class="foot-link" href="https://meshcore.ninja" target="_blank" rel="noreferrer">meshcore.ninja <span class="arrow">↗</span></a>
        <a class="foot-link" href="https://map.meshcore.ninja" target="_blank" rel="noreferrer">Map <span class="arrow">↗</span></a>
      </div>
    </div>
  </footer>
</div>

<style>
  /* Footer links: an accent underline sweeps in from the left, the text picks up
     a soft glow, and a little spark twinkles in — playful but restrained. */
  .foot-link {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.15em;
    color: inherit;
    text-decoration: none;
    transition:
      color 0.2s ease,
      text-shadow 0.2s ease;
  }

  .foot-link::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: -2px;
    height: 1px;
    width: 100%;
    transform: scaleX(0);
    transform-origin: left;
    background: linear-gradient(90deg, var(--color-accent), var(--color-accent2));
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .foot-link::before {
    content: '✦';
    position: absolute;
    top: -0.55em;
    right: -0.7em;
    font-size: 0.7em;
    color: var(--color-accent);
    opacity: 0;
    transform: scale(0.4) rotate(-30deg);
    pointer-events: none;
  }

  .foot-link:hover,
  .foot-link:focus-visible {
    color: var(--color-ink);
    text-shadow: 0 0 8px color-mix(in srgb, var(--color-accent) 45%, transparent);
    outline: none;
  }

  .foot-link:hover::after,
  .foot-link:focus-visible::after {
    transform: scaleX(1);
  }

  .foot-link:hover::before,
  .foot-link:focus-visible::before {
    animation: foot-spark 0.6s ease-out forwards;
  }

  .foot-link .arrow {
    display: inline-block;
    transition: transform 0.2s ease;
  }

  .foot-link:hover .arrow,
  .foot-link:focus-visible .arrow {
    transform: translate(2px, -2px);
  }

  @keyframes foot-spark {
    0% {
      opacity: 0;
      transform: scale(0.4) rotate(-30deg);
    }
    50% {
      opacity: 1;
      transform: scale(1.25) rotate(8deg);
    }
    100% {
      opacity: 0.9;
      transform: scale(1) rotate(0deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .foot-link::after,
    .foot-link .arrow {
      transition: none;
    }
    .foot-link:hover::before,
    .foot-link:focus-visible::before {
      animation: none;
      opacity: 0.9;
      transform: scale(1);
    }
  }
</style>

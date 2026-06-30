<script>
  import '../app.css';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { focusSearchInput } from '$lib/search.js';
  import ShortcutHint from '$lib/ShortcutHint.svelte';

  let { children } = $props();

  let theme = $state('dark');
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
</script>

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
        <button
          type="button"
          onclick={toggleTheme}
          class="shrink-0 cursor-pointer rounded-md border border-edge bg-bg px-2 py-1 text-sm text-dim hover:border-accent hover:text-ink"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
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
        <a class="foot-link" href="https://tangleveil.meshcore.ninja/" rel="noreferrer">Tangleveil</a>
        ·
        <a class="foot-link" href="https://github.com/meshcore-ninja/nodes.meshcore.ninja" rel="noreferrer">source code</a>
      </span>
      <div class="flex items-center justify-center gap-4 sm:justify-end">
        <a class="foot-link" href="https://meshcore.ninja" rel="noreferrer">meshcore.ninja <span class="arrow">↗</span></a>
        <a class="foot-link" href="https://map.meshcore.ninja" rel="noreferrer">Map <span class="arrow">↗</span></a>
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

<script>
  import '../app.css';
  import { base } from '$app/paths';
  import { page } from '$app/stores';

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
</script>

<div class="min-h-screen flex flex-col">
  {#if !isHome}
    <header class="border-b border-edge">
      <div class="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-4">
        <a href="{base}/" class="font-semibold tracking-tight flex items-center gap-2">
          <span class="text-accent">◇</span>
          <span>MeshCore Nodes</span>
        </a>
        <button
          onclick={toggleTheme}
          class="text-dim hover:text-ink text-sm rounded-md border border-edge px-2 py-1"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </header>
  {:else}
    <!-- Homepage has no top bar, so float the theme toggle in the corner. -->
    <button
      onclick={toggleTheme}
      class="absolute top-4 right-4 z-10 text-dim hover:text-ink text-sm rounded-md border border-edge px-2 py-1"
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  {/if}

  <main class="flex-1 flex flex-col">
    {@render children?.()}
  </main>

  <footer class="border-t border-edge text-dim text-xs">
    <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
      <span>Built from observed signed adverts · <span class="text-muted">MeshCore Ninja</span></span>
      <a class="hover:text-ink" href="https://map.meshcore.ninja" rel="noreferrer">Map ↗</a>
    </div>
  </footer>
</div>

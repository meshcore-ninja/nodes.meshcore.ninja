<script>
  import { base } from '$app/paths';
  import { RotateCw, House, WifiOff, SearchX, TriangleAlert } from '@lucide/svelte';

  // A centered, full-height error panel shared by the SvelteKit error boundary
  // (+error.svelte) and in-page failures (e.g. a node that won't load). `kind`
  // picks the icon + accent; `onRetry`, when given, renders a retry button.
  let {
    kind = 'error',
    title = 'Something went wrong',
    message = '',
    detail = '',
    onRetry = null,
    home = true
  } = $props();

  const ICON = { offline: WifiOff, notfound: SearchX, error: TriangleAlert };
  const Icon = $derived(ICON[kind] ?? TriangleAlert);
  const accent = $derived(
    kind === 'offline' ? 'text-warn' : kind === 'notfound' ? 'text-accent' : 'text-bad'
  );
  const ring = $derived(
    kind === 'offline'
      ? 'border-warn/40 bg-warn/10'
      : kind === 'notfound'
        ? 'border-accent/40 bg-accent/10'
        : 'border-bad/40 bg-bad/10'
  );
</script>

<div class="flex flex-1 items-center justify-center px-4 py-16">
  <div class="flex max-w-md flex-col items-center text-center">
    <div class={`grid h-14 w-14 place-items-center rounded-full border ${ring} ${accent}`}>
      <Icon size={26} aria-hidden="true" />
    </div>
    <h1 class="mt-5 text-xl font-semibold text-ink">{title}</h1>
    {#if message}
      <p class="mt-2 text-sm leading-relaxed text-dim">{message}</p>
    {/if}
    {#if detail}
      <p class="mt-3 max-w-full break-all rounded border border-edge bg-elev px-3 py-2 font-mono text-xs text-muted">
        {detail}
      </p>
    {/if}
    <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
      {#if onRetry}
        <button
          type="button"
          onclick={onRetry}
          class="inline-flex cursor-pointer items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <RotateCw size={15} aria-hidden="true" />
          Try again
        </button>
      {/if}
      {#if home}
        <a
          href="{base}/"
          class="inline-flex items-center gap-2 rounded-md border border-edge bg-bg px-4 py-2 text-sm text-dim hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <House size={15} aria-hidden="true" />
          Back to directory
        </a>
      {/if}
    </div>
  </div>
</div>

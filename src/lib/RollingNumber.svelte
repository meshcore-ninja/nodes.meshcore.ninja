<script>
  // A slide-up counter: renders a formatted number as a row of odometer digits
  // that roll to the new value whenever `value` changes. Commas render as plain
  // separators. The real number is exposed to assistive tech via aria-label.
  import RollingDigit from './RollingDigit.svelte';

  let { value = 0 } = $props();

  const nfmt = new Intl.NumberFormat('en-US');
  const text = $derived(nfmt.format(value));
  const chars = $derived(text.split(''));
</script>

<span class="inline-flex items-baseline text-ink" role="img" aria-label={text}>
  {#each chars as c, i (i)}
    {#if c >= '0' && c <= '9'}
      <RollingDigit char={c} />
    {:else}
      <span aria-hidden="true">{c}</span>
    {/if}
  {/each}
</span>

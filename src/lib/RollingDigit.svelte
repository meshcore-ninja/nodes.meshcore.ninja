<script>
  // One odometer-style digit. When `char` changes the old value slides up and
  // out while the new one slides up into place. Idle, it just shows the value.
  let { char = '0' } = $props();

  const SLIDE_MS = 320;
  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let current = $state(char); // settled / incoming value (bottom of the stack)
  let prev = $state(char); // outgoing value (top of the stack)
  let sliding = $state(false);
  let resetTimer;

  // Tracks `char` only (the reads of `current` just gate the no-op case and
  // settle immediately), so this can't loop.
  $effect(() => {
    const target = char;
    if (target === current) return;
    prev = current;
    current = target;
    if (reduced) {
      prev = target;
      return;
    }
    sliding = false;
    // Two frames so the browser paints the pre-slide position before we animate.
    requestAnimationFrame(() => requestAnimationFrame(() => (sliding = true)));
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      prev = current; // collapse the stack back to a single settled digit
      sliding = false;
    }, SLIDE_MS);
  });
</script>

<span class="window" aria-hidden="true">
  <span class="stack" class:sliding>
    <span class="cell">{prev}</span>
    <span class="cell">{current}</span>
  </span>
</span>

<style>
  .window {
    display: inline-block;
    height: 1.15em;
    line-height: 1.15em;
    overflow: hidden;
    vertical-align: -0.2em;
    font-variant-numeric: tabular-nums;
  }

  .stack {
    display: flex;
    flex-direction: column;
    transform: translateY(0);
  }

  .stack.sliding {
    transform: translateY(-1.15em);
    transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .cell {
    height: 1.15em;
    text-align: center;
  }
</style>

<script>
  // Renders the Lucide icon for a node type as static inline SVG.
  import { Smartphone, RadioTower, MessagesSquare, Gauge, CircleHelp } from '@lucide/svelte';

  let { type = 0, size = 18, class: cls = '' } = $props();

  const MAP = {
    1: Smartphone, // companion
    2: RadioTower, // repeater
    3: MessagesSquare, // room
    4: Gauge // sensor
  };
  const Icon = $derived(MAP[type] ?? CircleHelp);
</script>

<Icon {size} class={cls} strokeWidth={2} />

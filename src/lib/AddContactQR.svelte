<script>
  // QR code + deep link for adding this node as a contact in the MeshCore mobile
  // app, using the documented scheme:
  //   meshcore://contact/add?name=…&public_key=…&type=…
  // (see MeshCore/docs/qr_codes.md). Built from directory data — no signed card
  // needed. The QR is rendered on a white card so it stays scannable in any theme.
  import qrcode from 'qrcode-generator';
  import { TYPE_LABEL } from '$lib/format.js';

  let { pubkey, name = '', type = 0 } = $props();

  const url = $derived(
    `meshcore://contact/add?name=${encodeURIComponent(name || 'Node')}` +
      `&public_key=${pubkey}&type=${type || 1}`
  );

  const svg = $derived.by(() => {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  });

  let copied = $state(false);
  function copy() {
    navigator.clipboard?.writeText(url).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }
</script>

<div class="rounded-xl border border-edge bg-elev p-4">
  <div class="text-xs text-muted mb-3">Add to MeshCore app</div>
  <div class="mx-auto w-44 rounded-lg bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-auto">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html svg}
  </div>
  <p class="text-xs text-dim mt-3 text-center">
    Scan with the MeshCore mobile app to add this {TYPE_LABEL[type] ?? 'node'} as a contact.
  </p>
  <div class="mt-3 flex gap-2">
    <a
      href={url}
      class="flex-1 text-center rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink hover:border-accent"
    >
      Open in app
    </a>
    <button
      onclick={copy}
      class="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  </div>
</div>

<script lang="ts">
	// A menu at a point, for right click on the canvas.
	//
	// Shares MenuItem with the toolbar dropdowns, so the two cannot drift apart
	// in row height or hover behaviour. Positioning is flipped when the menu
	// would leave the window, which is the one thing a fixed dropdown does not
	// have to handle.
	import type { Snippet } from 'svelte';

	let {
		x = 0,
		y = 0,
		open = false,
		onclose,
		children
	}: {
		x?: number;
		y?: number;
		open?: boolean;
		onclose?: () => void;
		children: Snippet;
	} = $props();

	let sheet: HTMLDivElement | undefined = $state();
	let pos = $state({ left: 0, top: 0 });

	$effect(() => {
		if (!open || !sheet) return;
		// Measure, then keep it inside the window.
		const r = sheet.getBoundingClientRect();
		pos = {
			left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
			top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
		};
	});

	function onWindowPointerDown(e: PointerEvent) {
		if (open && sheet && !sheet.contains(e.target as Node)) onclose?.();
	}
	function onWindowKeyDown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') onclose?.();
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

{#if open}
	<div
		class="ctx"
		bind:this={sheet}
		style:left={`${pos.left}px`}
		style:top={`${pos.top}px`}
		role="menu"
		tabindex="-1"
	>
		{@render children()}
	</div>
{/if}

<style>
	.ctx {
		position: fixed;
		z-index: var(--z-tooltip);
		min-width: var(--w-menu-s);
		background: var(--bg-panel);
		border: var(--sep-w) solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-sheet);
		padding: var(--sp-1) 0;
	}
</style>

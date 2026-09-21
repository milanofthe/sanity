<script lang="ts">
	// A toolbar dropdown: a framed sheet anchored under its trigger, closing on
	// outside click or Escape. One implementation for every toolbar menu, so
	// they cannot drift apart in width, padding or dismiss behaviour.
	import type { Snippet } from 'svelte';

	// `open` is controlled rather than bound: the toolbar keeps at most one
	// menu open, and that rule belongs to whoever owns the set, not to each
	// menu individually.
	let {
		open = false,
		label,
		width = 'var(--menu-w)',
		ontoggle,
		onclose,
		children
	}: {
		open?: boolean;
		label: string;
		width?: string;
		ontoggle?: () => void;
		onclose?: () => void;
		children: Snippet;
	} = $props();

	let root: HTMLDivElement | undefined = $state();

	function onWindowPointerDown(e: PointerEvent) {
		if (!open) return;
		if (root && !root.contains(e.target as Node)) onclose?.();
	}
	function onWindowKeyDown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') onclose?.();
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div class="menu" bind:this={root}>
	<button class="trigger" class:on={open} onclick={() => ontoggle?.()}>
		{label}
		<span class="caret" aria-hidden="true">▾</span>
	</button>
	{#if open}
		<div class="sheet" style:width>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.menu {
		position: relative;
	}
	.trigger {
		font: 500 var(--fs-s) var(--font-ui);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 100%;
		padding: 0 var(--sp-3);
		background: none;
		border: none;
		color: var(--text-dim);
		cursor: pointer;
	}
	.trigger:hover,
	.trigger.on {
		background: var(--bg-hover);
		color: var(--text);
	}
	.caret {
		font-size: 8px;
		opacity: 0.7;
	}
	.sheet {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: var(--z-menu);
		background: var(--bg-panel);
		border: var(--sep-w) solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		padding: var(--sp-2) 0;
		max-height: 70vh;
		overflow-y: auto;
	}
</style>

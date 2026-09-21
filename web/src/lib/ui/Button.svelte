<script lang="ts">
	// sanity button. The logo is a wordmark inside a hard frame, so `primary`
	// is a filled rectangle with a frame and nothing is rounded anywhere.
	import type { Snippet } from 'svelte';

	let {
		variant = 'ghost',
		disabled = false,
		title = '',
		active = false,
		onclick,
		children
	}: {
		variant?: 'primary' | 'ghost';
		disabled?: boolean;
		title?: string;
		active?: boolean;
		onclick?: (e: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

<button class={variant} class:active {disabled} {title} {onclick}>
	<span class="inner">{@render children()}</span>
</button>

<style>
	button {
		font: 500 var(--fs-s) var(--font-ui);
		border: var(--sep-w) solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
		padding: 4px 10px;
		background: none;
		color: var(--text-dim);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.inner {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent-deep);
		border-color: var(--accent-deep);
	}

	.ghost:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.ghost.active {
		background: var(--bg-active);
		border-color: var(--border-strong);
		color: var(--text);
	}
	button:focus-visible {
		outline: var(--sep-w) solid var(--accent);
		outline-offset: 1px;
	}
</style>

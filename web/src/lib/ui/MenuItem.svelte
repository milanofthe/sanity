<script lang="ts">
	// One row in a Menu: a label, an optional trailing hint, an optional check.
	import type { Snippet } from 'svelte';

	let {
		label = '',
		hint = '',
		checked = false,
		disabled = false,
		onclick,
		children
	}: {
		label?: string;
		hint?: string;
		checked?: boolean;
		disabled?: boolean;
		onclick?: () => void;
		children?: Snippet;
	} = $props();
</script>

<button class="item" class:checked {disabled} {onclick}>
	<span class="mark" aria-hidden="true">{checked ? '·' : ''}</span>
	<span class="label">{children ? '' : label}{#if children}{@render children()}{/if}</span>
	{#if hint}<span class="hint">{hint}</span>{/if}
</button>

<style>
	.item {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		padding: 5px var(--sp-3);
		background: none;
		border: none;
		color: var(--text-dim);
		font: 500 var(--fs-s) var(--font-ui);
		text-align: left;
		cursor: pointer;
	}
	.item:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.item:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.mark {
		width: 6px;
		flex: none;
		color: var(--accent);
		font-size: 14px;
		line-height: 1;
	}
	.label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.checked .label {
		color: var(--text);
	}
	.hint {
		font: 400 var(--fs-xs) var(--font-mono);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		flex: none;
	}
</style>

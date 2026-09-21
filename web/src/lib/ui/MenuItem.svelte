<script lang="ts">
	// One row in a Menu: an optional check mark, a label, an optional hint.
	//
	// The row height is fixed. Letting each row size itself to its content had
	// rows of 10 and 24 pixels in the same menu, with the taller labels
	// overlapping their neighbours, because whether a row contained a check
	// mark changed its intrinsic height.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './Icon.svelte';

	let {
		label = '',
		hint = '',
		checked = false,
		disabled = false,
		icon,
		onclick,
		children
	}: {
		label?: string;
		hint?: string;
		checked?: boolean;
		disabled?: boolean;
		/** Leading icon. Replaces the check mark's slot, so a row has one or
		 *  the other and the labels still line up either way. */
		icon?: IconName;
		onclick?: () => void;
		children?: Snippet;
	} = $props();
</script>

<button class="item" class:checked {disabled} {onclick}>
	<span class="mark">
		{#if checked}<Icon name="check" size={11} width={2} />{:else if icon}<Icon
				name={icon}
				size={12}
			/>{/if}
	</span>
	<span class="label">
		{#if children}{@render children()}{:else}{label}{/if}
	</span>
	{#if hint}<span class="hint">{hint}</span>{/if}
</button>

<style>
	.item {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		min-height: var(--row-h);
		padding: 0 var(--sp-3);
		background: none;
		border: none;
		color: var(--text-dim);
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
		line-height: 1;
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
		width: 13px;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
	}
	.item:not(.checked) .mark {
		color: var(--text-faint);
	}
	.label {
		display: flex;
		align-items: center;
		gap: 7px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.checked .label {
		color: var(--text);
	}
	.hint {
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		flex: none;
	}
</style>

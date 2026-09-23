<script lang="ts">
	// One of a grid of choices, each a picture with its name under it: the
	// themes, where what is being chosen is how something looks and the
	// picture is the answer.
	//
	// A cell rather than a menu row: rows stack, and eight previews stacked
	// were a column taller than the window with each picture a strip too flat
	// to show a layout in.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		label,
		checked = false,
		onclick,
		children
	}: {
		label: string;
		checked?: boolean;
		onclick?: () => void;
		children?: Snippet;
	} = $props();
</script>

<button class="cell" class:checked {onclick}>
	{@render children?.()}
	<span class="name">
		<span class="mark">{#if checked}<Icon name="check" size={11} width={2} />{/if}</span>
		{label}
	</span>
</button>

<style>
	.cell {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		padding: var(--sp-1);
		border: var(--sep-w) solid transparent;
		border-radius: var(--radius);
		color: var(--text-dim);
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
		line-height: 1;
		text-align: left;
	}
	.cell:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.cell.checked {
		border-color: var(--accent);
		color: var(--text);
	}
	.name {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--h-mark);
	}
	.mark {
		display: flex;
		width: var(--h-mark);
		color: var(--accent);
	}
</style>

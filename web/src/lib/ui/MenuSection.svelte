<script lang="ts">
	// A titled group inside a Menu, with a rule above it.
	import type { Snippet } from 'svelte';
	let { title = '', children }: { title?: string; children: Snippet } = $props();
</script>

<div class="section">
	{#if title}<div class="title">{title}</div>{/if}
	{@render children()}
</div>

<style>
	.section + :global(.section),
	.section:not(:first-child) {
		border-top: var(--sep-w) solid var(--border);
		margin-top: var(--sp-2);
		padding-top: var(--sp-2);
	}
	.title {
		font: 600 var(--fs-xxs) var(--font-ui);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 2px var(--sp-3) var(--sp-1);
	}
</style>

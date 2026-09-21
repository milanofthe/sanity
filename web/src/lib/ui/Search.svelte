<script lang="ts">
	// A single line query field with a match counter.
	//
	// In the toolbar rather than as an overlay on the canvas: an overlay would
	// cover the thing being searched, and the canvas is the whole window.
	//
	// The counter is part of the field and not a separate label, because the
	// number only means anything next to the query that produced it.
	import Icon from '$lib/ui/Icon.svelte';

	let {
		value = '',
		count = 0,
		at = 0,
		placeholder = 'Search files',
		oninput,
		onnext,
		onprev,
		onclear
	}: {
		value?: string;
		/** Matches for the current query. */
		count?: number;
		/** Which match the camera is on, counting from one. Zero means none yet. */
		at?: number;
		placeholder?: string;
		oninput?: (value: string) => void;
		onnext?: () => void;
		onprev?: () => void;
		onclear?: () => void;
	} = $props();

	let el: HTMLInputElement | null = null;

	export function focus() {
		el?.focus();
		el?.select();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) onprev?.();
			else onnext?.();
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			// Clears first and gives up focus only when there is nothing to clear,
			// so one key both undoes the filter and gets out of the field.
			if (value) onclear?.();
			else el?.blur();
		}
	}
</script>

<div class="field" class:empty={!value}>
	<span class="glyph"><Icon name="search" /></span>
	<input
		bind:this={el}
		type="text"
		spellcheck="false"
		autocomplete="off"
		{placeholder}
		{value}
		{onkeydown}
		oninput={(e) => oninput?.(e.currentTarget.value)}
	/>
	{#if value}
		<span class="count" title="Enter for the next match, shift and Enter for the previous">
			{count === 0 ? 'none' : `${at || 1}/${count}`}
		</span>
	{/if}
</div>

<style>
	.field {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		align-self: center;
		/* A definite height rather than one computed from the input's padding,
		   so the icon and the text are centred by the same rule and share a
		   mid line. With the height coming from padding they were centred
		   against different boxes and the text sat a pixel low. */
		height: var(--field-h);
		padding: 0 var(--sp-2);
		border: var(--sep-w) solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text-dim);
	}
	.field:focus-within {
		border-color: var(--accent);
		color: var(--text);
	}
	.glyph {
		display: flex;
		color: var(--text-faint);
	}
	input {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		/* Full height with no padding: an input centres its text in its own
		   content box, so making that box the whole field puts the text on the
		   field's mid line, placeholder and typed text alike. */
		height: 100%;
		line-height: 1;
		width: 26ch;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
	}
	input::placeholder {
		color: var(--text-faint);
	}
	input:focus {
		outline: none;
	}
	.count {
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>

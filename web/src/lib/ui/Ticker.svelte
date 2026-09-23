<script lang="ts">
	// A step control through a sequence: older, newer, where it is, and a way
	// back to the present. The history ticker in the toolbar.
	//
	// A field like the search next to it, so the toolbar has one kind of
	// control on its right: a bordered box of the field height, text in the
	// UI face, the thing being named in mono.
	import Icon from '$lib/ui/Icon.svelte';

	let {
		label,
		detail = '',
		title = '',
		older = false,
		newer = false,
		present = true,
		onolder,
		onnewer,
		onpresent
	}: {
		/** Where it is: a commit's short id, or "now". */
		label: string;
		/** What is there, a commit's subject. */
		detail?: string;
		title?: string;
		/** Whether there is anything to step to either way. */
		older?: boolean;
		newer?: boolean;
		/** Showing the present, so there is nothing to go back to. */
		present?: boolean;
		onolder?: () => void;
		onnewer?: () => void;
		onpresent?: () => void;
	} = $props();
</script>

<div class="ticker" class:past={!present} {title}>
	<button class="step" disabled={!older} aria-label="Older" onclick={() => onolder?.()}>
		<Icon name="chevron-left" size={13} />
	</button>
	<button class="step" disabled={!newer} aria-label="Newer" onclick={() => onnewer?.()}>
		<Icon name="chevron-right" size={13} />
	</button>
	<button class="where" disabled={present} onclick={() => onpresent?.()}>{label}</button>
	{#if detail}
		<span class="detail">{detail}</span>
	{/if}
</div>

<style>
	.ticker {
		display: flex;
		align-items: center;
		align-self: center;
		height: var(--field-h);
		margin-right: var(--sp-2);
		border: var(--sep-w) solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text-dim);
		min-width: 0;
	}
	/* In the past the whole control says so, in the accent: the canvas is not
	   showing the folder as it is, and that must not be missed. */
	.ticker.past {
		border-color: var(--accent);
	}
	button {
		display: flex;
		align-items: center;
		height: 100%;
		padding: 0 var(--sp-1);
		border: none;
		background: none;
		color: var(--text-dim);
	}
	button:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	button:disabled {
		color: var(--text-faint);
	}
	.where {
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		padding: 0 var(--sp-2);
		border-left: var(--sep-w) solid var(--border);
	}
	.past .where {
		color: var(--accent);
	}
	.detail {
		font-family: var(--font-ui);
		font-size: var(--fs-xs);
		color: var(--text-faint);
		padding-right: var(--sp-2);
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

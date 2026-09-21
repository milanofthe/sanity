<script lang="ts">
	// A row of mutually exclusive options, framed as one block.
	//
	// Used for the per-file-type view mode, which needs three states rather
	// than a checkbox: shown in full, kept as a placeholder so you can see the
	// file exists, or gone. A checkbox cannot say "present but not readable".
	// Controlled, like Menu: the selected value usually lives in app state, and
	// a two-way binding would make that state's own rules unenforceable.
	let {
		value = '',
		options,
		disabled = false,
		onchange
	}: {
		value?: string;
		options: { id: string; label: string; title?: string }[];
		disabled?: boolean;
		onchange?: (id: never) => void;
	} = $props();
</script>

<div class="seg" class:disabled role="radiogroup">
	{#each options as o (o.id)}
		<button
			class:on={value === o.id}
			role="radio"
			aria-checked={value === o.id}
			title={o.title ?? ''}
			{disabled}
			onclick={() => onchange?.(o.id as never)}
		>
			{o.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		border: var(--sep-w) solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-inset);
		overflow: hidden;
	}
	button {
		font-family: var(--font-ui);
		font-size: var(--fs-xs);
		font-weight: 500;
		line-height: 1;
		background: none;
		border: none;
		border-left: var(--sep-w) solid var(--border);
		color: var(--text-faint);
		padding: 3px 8px;
		cursor: pointer;
		white-space: nowrap;
	}
	button:first-child {
		border-left: none;
	}
	button:hover:not(:disabled):not(.on) {
		background: var(--bg-hover);
		color: var(--text-dim);
	}
	button.on {
		background: var(--bg-active);
		color: var(--text);
	}
	.seg.disabled {
		opacity: 0.45;
	}
	button:focus-visible {
		outline: var(--sep-w) solid var(--accent);
		outline-offset: -1px;
	}
</style>

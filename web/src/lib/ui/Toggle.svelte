<script lang="ts">
	// Custom checkbox: a square frame that fills with the accent, echoing the
	// logo's box. No rounding, no animation beyond the fill.
	let {
		checked = $bindable(false),
		label = '',
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		label?: string;
		disabled?: boolean;
		/** For a switch whose state lives somewhere else, where binding would
		 *  write it in two places. */
		onchange?: (on: boolean) => void;
	} = $props();
</script>

<label class="toggle" class:on={checked} class:disabled>
	<input
		type="checkbox"
		bind:checked
		{disabled}
		onchange={(e) => onchange?.(e.currentTarget.checked)}
	/>
	<span class="box" aria-hidden="true">
		<svg viewBox="0 0 10 10"><path d="M1.5 5.5 4 8 8.5 2" /></svg>
	</span>
	{#if label}<span class="lbl">{label}</span>{/if}
</label>

<style>
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		cursor: pointer;
		user-select: none;
	}
	input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.box {
		width: 13px;
		height: 13px;
		border: var(--sep-w) solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-inset);
		display: grid;
		place-items: center;
		flex: none;
		transition: background 80ms, border-color 80ms;
	}
	.on .box {
		background: var(--accent);
		border-color: var(--accent);
	}
	.box svg {
		width: 9px;
		height: 9px;
		fill: none;
		stroke: var(--on-accent);
		stroke-width: 2;
		stroke-linecap: square;
		visibility: hidden;
	}
	.on .box svg {
		visibility: visible;
	}
	input:focus-visible + .box {
		outline: var(--sep-w) solid var(--accent);
		outline-offset: 1px;
	}
	.lbl {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
		color: var(--text-dim);
	}
	.on .lbl {
		color: var(--text);
	}
	.toggle.disabled {
		cursor: default;
		opacity: 0.45;
	}
</style>

<script lang="ts">
	// A switch: a track the knob sits in, left for off and right for on.
	//
	// Next to Toggle rather than replacing it. A checkbox says "this item is
	// selected", which is what a list of choices needs; a switch says "this is
	// on or off", which is what a setting that changes the canvas is. The two
	// read differently at a glance and the difference is worth keeping.
	//
	// Square, like the logo and like Toggle's box: the theme has one corner
	// radius and it is small, so a pill would be the one rounded thing in the
	// interface.
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

<label class="switch" class:on={checked} class:disabled>
	{#if label}<span class="lbl">{label}</span>{/if}
	<input
		type="checkbox"
		role="switch"
		bind:checked
		{disabled}
		onchange={(e) => onchange?.(e.currentTarget.checked)}
	/>
	<span class="track" aria-hidden="true"><span class="knob"></span></span>
</label>

<style>
	.switch {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		width: 100%;
		cursor: pointer;
		user-select: none;
	}
	input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.track {
		position: relative;
		width: var(--w-switch);
		height: var(--h-mark);
		flex: none;
		border: var(--sep-w) solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-inset);
		transition: background var(--dur-1), border-color var(--dur-1);
	}
	.knob {
		position: absolute;
		top: var(--sep-w);
		left: var(--sep-w);
		/* The track less its border and the travel, so the knob is square. */
		width: calc(var(--h-mark) - 4 * var(--sep-w));
		height: calc(var(--h-mark) - 4 * var(--sep-w));
		background: var(--text-faint);
		transition: transform var(--dur-1), background var(--dur-1);
	}
	.on .track {
		background: var(--accent);
		border-color: var(--accent);
	}
	.on .knob {
		background: var(--on-accent);
		transform: translateX(calc(var(--w-switch) - var(--h-mark) + 2 * var(--sep-w)));
	}
	input:focus-visible + .track {
		outline: var(--sep-w) solid var(--accent);
		outline-offset: var(--sp-0);
	}
	.lbl {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
		color: var(--text-dim);
		min-width: 0;
	}
	.on .lbl {
		color: var(--text);
	}
	.switch.disabled {
		cursor: default;
		opacity: 0.45;
	}
</style>

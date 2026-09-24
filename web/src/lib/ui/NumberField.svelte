<script lang="ts">
	// A number with a step down and a step up, framed as one block like
	// Segmented. The browser's own number field draws its spinners in the
	// system's style, which no theme reaches, so this is a text field that
	// only takes a number, with buttons of the app's own.
	//
	// The keyboard works as in the native one: up and down step, Enter and
	// leaving the field take what was typed, clamped to the range. Controlled,
	// like the other controls: the value is reported, not bound.
	import Icon from './Icon.svelte';

	let {
		value,
		min = -Infinity,
		max = Infinity,
		step = 1,
		disabled = false,
		label = '',
		onchange
	}: {
		value: number;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		/** What the number is, for assistive technology. */
		label?: string;
		onchange?: (value: number) => void;
	} = $props();

	let text = $state('');
	$effect(() => {
		text = String(value);
	});

	const clamp = (n: number) => Math.min(max, Math.max(min, n));

	function commit(n: number) {
		const next = clamp(Number.isFinite(n) ? n : value);
		text = String(next);
		if (next !== value) onchange?.(next);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			commit(value + (e.key === 'ArrowUp' ? step : -step));
		} else if (e.key === 'Enter') {
			commit(Number(text));
		}
	}
</script>

<div class="num" class:disabled>
	<button
		aria-label="Less"
		tabindex="-1"
		disabled={disabled || value <= min}
		onclick={() => commit(value - step)}
	>
		<Icon name="minus" size={11} />
	</button>
	<input
		type="text"
		inputmode="numeric"
		aria-label={label}
		{disabled}
		value={text}
		oninput={(e) => (text = e.currentTarget.value.replace(/[^0-9]/g, ''))}
		onblur={() => commit(Number(text))}
		{onkeydown}
	/>
	<button
		aria-label="More"
		tabindex="-1"
		disabled={disabled || value >= max}
		onclick={() => commit(value + step)}
	>
		<Icon name="plus" size={11} />
	</button>
</div>

<style>
	.num {
		display: inline-flex;
		height: var(--h-field);
		border: var(--sep-w) solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-inset);
		overflow: hidden;
	}
	button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--h-field);
		border: none;
		color: var(--text-faint);
	}
	button:first-child {
		border-right: var(--sep-w) solid var(--border);
	}
	button:last-child {
		border-left: var(--sep-w) solid var(--border);
	}
	button:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-dim);
	}
	button:active:not(:disabled) {
		background: var(--bg-active);
		color: var(--text);
	}
	button:disabled {
		opacity: 0.45;
	}
	input {
		width: calc(2 * var(--h-field));
		padding: 0 var(--sp-2);
		border: none;
		background: transparent;
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		color: var(--text);
		text-align: center;
	}
	input:focus-visible {
		outline: var(--sep-w) solid var(--accent);
		outline-offset: calc(-1 * var(--sep-w));
	}
	.num.disabled {
		opacity: 0.45;
	}
</style>

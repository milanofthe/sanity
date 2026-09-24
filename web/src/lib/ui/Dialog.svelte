<script lang="ts">
	// A sheet in the middle of the window over a dimmed canvas, for a task that
	// needs a few settings and then runs: the video export. Closes on Escape
	// and on a click beside it, unless `busy`, when what it started is still
	// running and closing would hide the only way to stop it.
	import type { Snippet } from 'svelte';

	let {
		open = false,
		title,
		busy = false,
		onclose,
		children,
		actions
	}: {
		open?: boolean;
		title: string;
		busy?: boolean;
		onclose?: () => void;
		children: Snippet;
		/** The buttons along the bottom, right aligned. */
		actions?: Snippet;
	} = $props();

	function onWindowKeyDown(e: KeyboardEvent) {
		if (open && !busy && e.key === 'Escape') onclose?.();
	}
</script>

<svelte:window onkeydown={onWindowKeyDown} />

{#if open}
	<div
		class="backdrop"
		role="presentation"
		onpointerdown={(e) => {
			if (e.target === e.currentTarget && !busy) onclose?.();
		}}
	>
		<div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
			<div class="title">{title}</div>
			<div class="body">{@render children()}</div>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</div>
	</div>
{/if}

<style>
	.backdrop {
		animation: backdrop-in var(--dur-2) ease-out;
		position: fixed;
		inset: 0;
		z-index: var(--z-backdrop);
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg) 60%, transparent);
	}
	.sheet {
		animation: sheet-in var(--dur-2) ease-out;
		z-index: var(--z-sheet);
		width: var(--w-menu-l);
		background: var(--bg-panel);
		border: var(--sep-w) solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-sheet);
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		color: var(--text);
	}
	.title {
		display: flex;
		align-items: center;
		height: var(--h-row);
		padding: 0 var(--sp-3);
		border-bottom: var(--sep-w) solid var(--border);
		font-weight: 600;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		border-top: var(--sep-w) solid var(--border);
	}
	.actions :global(button) {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		height: var(--h-field);
		padding: 0 var(--sp-3);
		border: var(--sep-w) solid var(--border);
		border-radius: var(--radius);
		color: var(--text-dim);
	}
	.actions :global(button:hover:not(:disabled)) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.actions :global(button.primary) {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.actions :global(button.primary:hover:not(:disabled)) {
		background: var(--accent-deep);
		color: var(--on-accent);
	}
	.actions :global(button:disabled) {
		opacity: 0.45;
	}
</style>

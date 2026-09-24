<script lang="ts">
	// The history replay as a video: how long, how large, from where, and then
	// the export itself, with its progress and a way to stop it.
	//
	// What the settings come to is said before anything starts, since a target
	// length is a wish: a short history plays every commit and ends sooner, a
	// long one plays several commits a step.
	import type { CanvasApp } from '$lib/canvas/app';
	import { exportName } from '$lib/image';
	import { history } from '$lib/state/history.svelte';
	import { historyReplay, openVideoSink } from '$lib/sources/tauri';
	import Dialog from '$lib/ui/Dialog.svelte';
	import NumberField from '$lib/ui/NumberField.svelte';
	import Segmented from '$lib/ui/Segmented.svelte';
	import {
		planReplay,
		renderReplay,
		videoCodec,
		VIDEO_FPS,
		type VideoCodecChoice,
		type VideoSize
	} from '$lib/video';

	let {
		open = false,
		app,
		onclose,
		ondone
	}: {
		open?: boolean;
		app: CanvasApp | null | undefined;
		onclose?: () => void;
		/** Where the video went, for the status bar. */
		ondone?: (path: string) => void;
	} = $props();

	let seconds = $state(60);
	let size = $state<VideoSize>('1080p');
	/** From the oldest loaded commit, or from the one the ticker shows. */
	let range = $state<'all' | 'ticker'>('all');

	/** What this machine can write a video of this size in: undefined while
	 *  that is being found out, null when it cannot write one at all. */
	let codec = $state<VideoCodecChoice | null | undefined>(undefined);
	$effect(() => {
		if (!open) return;
		const asked = size;
		codec = undefined;
		void videoCodec(asked).then((c) => {
			if (asked === size) codec = c;
		});
	});

	let running = $state(false);
	let done = $state(0);
	let total = $state(0);
	let error = $state<string | null>(null);
	let ctl: AbortController | null = null;

	const oldest = $derived(history.commits.length - 1);
	const from = $derived(range === 'ticker' && history.at > 0 ? history.at : oldest);
	const plan = $derived(planReplay(from, 0, seconds));
	const commits = $derived(from + 1);

	async function start() {
		if (!app || running) return;
		error = null;
		const sink = await openVideoSink(exportName('history', 'mp4'));
		if (!sink) return;
		running = true;
		done = 0;
		total = plan.frames;
		ctl = new AbortController();
		const source = historyReplay(app);
		try {
			const where = await renderReplay(app, plan, source, sink, {
				size,
				codec: codec?.codec,
				onProgress: (d, t) => {
					done = d;
					total = t;
				},
				signal: ctl.signal
			});
			if (where) {
				ondone?.(where);
				onclose?.();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			source.release();
			running = false;
			ctl = null;
		}
	}

	/** Seconds up to two minutes, minutes and seconds past that. */
	function minutes(s: number): string {
		const r = Math.round(s);
		if (r < 120) return `${r} s`;
		return r % 60 ? `${Math.floor(r / 60)} min ${r % 60} s` : `${r / 60} min`;
	}
</script>

<Dialog {open} title="Export history as video" busy={running} onclose={() => onclose?.()}>
	<div class="row">
		<span class="label">Length</span>
		<span class="field">
			<NumberField
				value={seconds}
				min={5}
				max={600}
				step={5}
				label="Length in seconds"
				disabled={running}
				onchange={(v) => (seconds = v)}
			/>
			<span class="unit">seconds</span>
		</span>
	</div>
	<div class="row">
		<span class="label">Size</span>
		<Segmented
			value={size}
			disabled={running}
			options={[
				{ id: '1080p', label: '1080p' },
				{ id: '4K', label: '4K' }
			]}
			onchange={(id: VideoSize) => (size = id)}
		/>
	</div>
	<div class="row">
		<span class="label">From</span>
		<Segmented
			value={range}
			disabled={running || history.at <= 0}
			options={[
				{ id: 'all', label: 'the oldest commit' },
				{ id: 'ticker', label: "the ticker's commit", title: 'The commit the ticker shows, up to the newest' }
			]}
			onchange={(id: 'all' | 'ticker') => (range = id)}
		/>
	</div>
	<p class="summary">
		{commits} commits in {plan.targets.length} steps, {minutes(plan.seconds)} at {VIDEO_FPS} frames a second{#if codec},
			{codec.name}{/if}.
	</p>
	{#if codec === null}
		<p class="error">This machine has no video encoder for {size}. Try 1080p, or update the graphics driver.</p>
	{/if}
	{#if running}
		<div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
			<div class="bar" style:width={`${total ? (100 * done) / total : 0}%`}></div>
		</div>
		<p class="summary">Frame {done} of {total}</p>
	{/if}
	{#if error}<p class="error">{error}</p>{/if}

	{#snippet actions()}
		{#if running}
			<button onclick={() => ctl?.abort()}>Cancel</button>
		{:else}
			<button onclick={() => onclose?.()}>Close</button>
			<button class="primary" disabled={!app || commits < 2 || !codec} onclick={start}>Export</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		height: var(--h-field);
	}
	.label {
		width: var(--w-mode);
		color: var(--text-dim);
	}
	.row :global(.seg) {
		height: var(--h-field);
	}
	.field {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.unit,
	.summary {
		color: var(--text-dim);
	}
	.summary {
		margin: 0;
		font-size: var(--fs-xs);
	}
	.progress {
		height: var(--sp-1);
		background: var(--bg-inset);
		border: var(--sep-w) solid var(--border);
	}
	.bar {
		height: 100%;
		background: var(--accent);
	}
	.error {
		margin: 0;
		color: var(--error);
	}
</style>

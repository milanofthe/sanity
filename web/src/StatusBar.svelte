<script lang="ts">
	// One line of numbers. Kept visible rather than behind a debug flag: the
	// whole app is about seeing the shape of a project, and how much of it is
	// on screen at what detail is part of that.
	import type { CanvasStats } from '$lib/canvas/app';
	import { project } from '$lib/state/project.svelte';

	let { stats, error = null }: { stats: CanvasStats | null; error?: string | null } = $props();

	const n = (v: number) => v.toLocaleString('en-US');
</script>

<footer>
	{#if error}
		<span class="group err" title={error}>{error}</span>
	{/if}
	{#if stats}
		<span class="group">
			<b>{n(stats.files)}</b> files
			<span class="dot">·</span>
			<b>{n(stats.totalLines)}</b> lines
			{#if project.stubbedLines > 0}
				<span class="dot">·</span>
				<span class="dim">{n(project.stubbedLines)} stubbed</span>
			{/if}
		</span>
		<span class="group">
			lod <b>{stats.lod}</b>
			<span class="dot">·</span>
			{stats.pxPerLine.toFixed(2)} px/line
			<span class="dot">·</span>
			{n(stats.visibleFiles)} visible
		</span>
		<span class="spacer"></span>
		{#if stats.indexing > 0}
			<span class="group accent">indexing {Math.round(stats.indexing * 100)}%</span>
		{/if}
		<span class="group dim">
			fill {Math.round(stats.fill * 100)}%
			<span class="dot">·</span>
			{n(stats.quads)} quads
			<span class="dot">·</span>
			{stats.cpuMs.toFixed(2)} ms cpu
			<span class="dot">·</span>
			{stats.frameMs.toFixed(1)} ms frame
			<span class="dot">·</span>
			{stats.vramMb.toFixed(0)} MB
		</span>
	{/if}
</footer>

<style>
	footer {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
		padding: 0 var(--sp-3);
		background: var(--bg-panel);
		border-top: var(--sep-w) solid var(--border);
		font-family: var(--font-ui);
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
		z-index: var(--z-chrome);
		user-select: none;
	}
	.group {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
	}
	b {
		color: var(--text);
		font-weight: 600;
	}
	.dot {
		color: var(--text-faint);
	}
	.dim {
		color: var(--text-faint);
	}
	.accent {
		color: var(--accent);
	}
	.err {
		color: var(--error);
		max-width: 50ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spacer {
		flex: 1;
	}
</style>

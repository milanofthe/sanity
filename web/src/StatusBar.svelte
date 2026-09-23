<script lang="ts">
	// One line of numbers. Kept visible rather than behind a debug flag: the
	// whole app is about seeing the shape of a project, and how much of it is
	// on screen at what detail is part of that.
	import type { CanvasStats } from '$lib/canvas/app';
	import { project } from '$lib/state/project.svelte';

	let {
		stats,
		hover = null,
		error = null,
		notice = null,
		contextLost = false
	}: {
		stats: CanvasStats | null;
		/** Path under the pointer, or null. */
		hover?: string | null;
		error?: string | null;
		/** Something that just happened and is worth one line, such as where an
		 *  image was written. Cleared by whoever set it. */
		notice?: string | null;
		/** The GPU has taken the WebGL context away. The canvas is empty until
		 *  it comes back, and an empty canvas with no explanation reads as a
		 *  bug in the layout rather than as a driver event. */
		contextLost?: boolean;
	} = $props();

	/** Longest path shown before the directory is cut from the front. */
	const CRUMB_CHARS = 44;
	const cut = $derived(hover ? hover.lastIndexOf('/') + 1 : 0);
	const hoverName = $derived(hover ? hover.slice(cut) : '');
	/**
	 * The directory in front of the name, shortened from its front.
	 *
	 * Shortened here rather than by CSS. It used to be `direction: rtl` on the
	 * element with `text-overflow: ellipsis`, which cuts a path at the correct
	 * end and also reverses the order of the two spans inside it: the bar read
	 * `simulation.py src/pathsim/` while the markup said
	 * `src/pathsim/simulation.py`.
	 */
	const hoverDir = $derived.by(() => {
		if (!hover) return '';
		const dir = hover.slice(0, cut);
		const room = CRUMB_CHARS - hoverName.length;
		if (dir.length <= room) return dir;
		return room > 3 ? `..${dir.slice(dir.length - (room - 2))}` : '';
	});

	const n = (v: number) => v.toLocaleString('en-US');

	// A change that arrived within this window is still worth pointing at; past
	// it the panel glow has faded anyway and the count is the whole story.
	const RECENT_MS = 8000;
	let now = $state(performance.now());
	$effect(() => {
		// One tick a second, only while something is being watched: the "just
		// now" marker is the only thing here that changes without a frame.
		if (!project.watching) return;
		const id = setInterval(() => (now = performance.now()), 1000);
		return () => clearInterval(id);
	});
	let justChanged = $derived(
		project.lastChangeAt > 0 && now - project.lastChangeAt < RECENT_MS
	);
</script>

<footer>
	{#if error}
		<span class="group err" title={error}>{error}</span>
	{:else if notice}
		<span class="group note" title={notice}>{notice}</span>
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
			<span class="dim" title="Hand-over bands in px/line: tokens, then text">
				{stats.bands}
			</span>
			<span class="dot">·</span>
			{n(stats.visibleFiles)} visible
		</span>
		{#if project.watching}
			<span class="group" title="Watching the folder for saves">
				<span class="pip" class:hot={justChanged}></span>
				live
				{#if project.changed > 0}
					<span class="dot">·</span>
					<b>{n(project.changed)}</b> changed
				{/if}
			</span>
		{/if}
		<span class="spacer"></span>
		{#if contextLost}
			<span class="group accent">graphics context lost, waiting for it to come back</span>
		{/if}
		{#if hover}
			<!-- Where the pointer is. Out at the structural zoom levels the
			     directory labels are gone and a panel header is a hairline, so
			     this is the only thing that still names what is under the
			     cursor. The directories are dimmed and the file is not: the
			     name is the answer, the path is the context. -->
			<span class="group crumb" title={hover}>
				<span class="dim">{hoverDir}</span>{hoverName}
			</span>
		{/if}
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
		/* Clips rather than pushes: the numbers are secondary, and letting them
		   widen the grid made the canvas aspect follow the text. */
		min-width: 0;
		overflow: hidden;
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
		gap: var(--sp-1);
		white-space: nowrap;
	}
	b {
		color: var(--text);
		font-weight: 600;
	}
	.crumb {
		font-family: var(--font-mono);
		white-space: nowrap;
		/* A path is one word: no gap between the directory and the name, the
		   way the panel headers write it. */
		gap: 0;
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
	/* A watching indicator, not a decoration: filled while a change is fresh,
	   outlined while the watch is simply up. */
	.pip {
		width: var(--sp-2);
		height: var(--sp-2);
		border-radius: 50%;
		border: var(--sep-w) solid var(--text-faint);
	}
	.pip.hot {
		background: var(--accent);
		border-color: var(--accent);
	}
	.err {
		color: var(--error);
		max-width: 50ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.note {
		color: var(--accent);
		max-width: 60ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spacer {
		flex: 1;
	}
</style>

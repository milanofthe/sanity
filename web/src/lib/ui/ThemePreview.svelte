<script lang="ts">
	// A miniature of the canvas in one theme: the ground, a directory frame, a
	// panel with a header, and a few lines of code as token-coloured bars.
	//
	// Three colour chips were what this replaced, and they could not answer the
	// question anyone picking a theme has: not "which three colours" but "what
	// does my code look like in it". The bars are the same shape the renderer
	// draws at the zoom where a panel is a few pixels a line, so the preview is
	// a picture of the thing rather than a legend for it.
	//
	// It works because the theme blocks in tokens.css are written as
	// `[data-theme='x']` rather than `:root[data-theme='x']`, so setting the
	// attribute on this element resolves every token inside it to that theme
	// without touching the app's own.
	let {
		theme,
		width = 132,
		height = 44
	}: { theme: string; width?: number; height?: number } = $props();

	// One row per line, as a fraction of the panel width and a token slot. The
	// shape is a stand-in for real code: a comment, an import, a signature, a
	// couple of bodies. Fixed rather than random so two previews next to each
	// other differ only by their colours.
	const ROWS: [number, number, string][] = [
		[0, 0.62, 'comment'],
		[0, 0.34, 'keyword'],
		[0, 0.5, 'type'],
		[0.08, 0.46, 'string'],
		[0.08, 0.3, 'number'],
		[0.08, 0.54, 'function'],
		[0, 0.22, 'punctuation']
	];
</script>

<span class="frame" data-theme={theme} style:width={`${width}px`} style:height={`${height}px`}>
	<span class="dir">
		<span class="panel">
			<span class="head"></span>
			{#each ROWS as [indent, len, tok], i (i)}
				<span
					class="line"
					style:margin-left={`${indent * 100}%`}
					style:width={`${len * 100}%`}
					style:background={`var(--tok-${tok})`}
				></span>
			{/each}
		</span>
	</span>
</span>

<style>
	.frame {
		display: block;
		flex: none;
		background: var(--bg);
		border: var(--sep-w) solid var(--border);
		overflow: hidden;
	}
	.dir {
		display: block;
		height: 100%;
		padding: 3px;
		background: var(--dir-bg);
	}
	.panel {
		display: flex;
		flex-direction: column;
		gap: 2px;
		height: 100%;
		padding: 0 3px 3px;
		background: var(--panel-bg);
		border: var(--sep-w) solid var(--border);
	}
	.head {
		display: block;
		height: 5px;
		margin: 0 -3px 2px;
		background: var(--panel-bg-alt);
		border-bottom: var(--sep-w) solid var(--border);
	}
	.line {
		display: block;
		height: 2px;
		flex: none;
	}
</style>

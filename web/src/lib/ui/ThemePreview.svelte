<script lang="ts">
	// A miniature of the canvas in one theme: the ground, a directory frame
	// with its name, and two panels, each with a header, line numbers, code
	// in the token colours, and a line added and a line removed.
	//
	// Three colour chips were what the first version replaced, and they could
	// not answer the question anyone picking a theme has: not "which three
	// colours" but "what does my code look like in it". This is the second
	// version: the first was a strip three times wider than tall with one
	// panel of bars in it, too flat to show a layout and without the two
	// colours a change is drawn in, which are the ones this app is watched for.
	//
	// It works because the theme blocks in tokens.css are written as
	// `[data-theme='x']` rather than `:root[data-theme='x']`, so setting the
	// attribute on this element resolves every token inside it to that theme
	// without touching the app's own.
	//
	// With one catch, which cost a round: only the properties each theme block
	// declares itself re-resolve here. The derived aliases in `:root`, such as
	// `--panel-bg: var(--bg-panel)`, are substituted where they are declared
	// and inherited as the finished colour, so a nested context gets the active
	// theme's value however its own `data-theme` reads. Every light preview
	// came out with a dark panel that way. So this uses the source properties,
	// `--bg-panel` and `--bg-inset`, and theme-check asserts per preview that
	// the panel in it is that theme's panel.
	let {
		theme,
		width = 144,
		height = 96
	}: { theme: string; width?: number; height?: number } = $props();

	type Seg = [number, string];
	/** A line: its indent as a fraction of the panel, its segments as width
	 *  and token, and a change band on it if any. Fixed, so two previews next
	 *  to each other differ only by their colours. */
	type Line = { indent: number; segs: Seg[]; band?: 'added' | 'deleted' };

	const WIDE: Line[] = [
		{ indent: 0, segs: [[0.62, 'comment']] },
		{ indent: 0, segs: [[0.14, 'keyword'], [0.22, 'type'], [0.04, 'punctuation']] },
		{ indent: 0, segs: [[0.12, 'keyword'], [0.2, 'function'], [0.1, 'punctuation']] },
		{ indent: 0.08, segs: [[0.1, 'keyword'], [0.16, 'variable'], [0.24, 'string']], band: 'added' },
		{ indent: 0.08, segs: [[0.1, 'keyword'], [0.14, 'variable'], [0.08, 'number']], band: 'added' },
		{ indent: 0.08, segs: [[0.22, 'function'], [0.06, 'punctuation'], [0.12, 'constant']] },
		{ indent: 0.08, segs: [[0.34, 'variable'], [0.04, 'punctuation']], band: 'deleted' },
		{ indent: 0, segs: [[0.04, 'punctuation']] },
		{ indent: 0, segs: [[0.5, 'comment']] },
		{ indent: 0, segs: [[0.12, 'keyword'], [0.18, 'function'], [0.1, 'punctuation']] },
		{ indent: 0.08, segs: [[0.2, 'variable'], [0.3, 'string']] },
		{ indent: 0.08, segs: [[0.1, 'keyword'], [0.2, 'variable']] },
	];
	const NARROW: Line[] = [
		{ indent: 0, segs: [[0.3, 'keyword'], [0.4, 'type']] },
		{ indent: 0.12, segs: [[0.5, 'string']] },
		{ indent: 0.12, segs: [[0.34, 'number']] },
		{ indent: 0.12, segs: [[0.26, 'variable'], [0.3, 'function']] },
		{ indent: 0, segs: [[0.1, 'punctuation']] },
		{ indent: 0, segs: [[0.6, 'comment']] },
		{ indent: 0, segs: [[0.28, 'keyword'], [0.36, 'type']] },
		{ indent: 0.12, segs: [[0.4, 'function']] },
		{ indent: 0.12, segs: [[0.2, 'constant'], [0.2, 'string']] },
		{ indent: 0, segs: [[0.1, 'punctuation']] },
	];
</script>

{#snippet panel(lines: Line[], name: number)}
	<span class="panel">
		<span class="head"><span class="title" style:width={`${name * 100}%`}></span></span>
		<span class="body">
			{#each lines as l, i (i)}
				<span class="line {l.band ?? ''}">
					<span class="num"></span>
					<span class="code" style:padding-left={`${l.indent * 100}%`}>
						{#each l.segs as [w, tok], k (k)}
							<span class="seg" style:width={`${w * 100}%`} style:background={`var(--tok-${tok})`}></span>
						{/each}
					</span>
				</span>
			{/each}
		</span>
	</span>
{/snippet}

<span class="frame" data-theme={theme} style:width={`${width}px`} style:height={`${height}px`}>
	<span class="dir">
		<span class="label"></span>
		<span class="panels">
			{@render panel(WIDE, 0.4)}
			{@render panel(NARROW, 0.55)}
		</span>
	</span>
</span>

<style>
	.frame {
		display: block;
		flex: none;
		padding: var(--sp-1);
		background: var(--bg);
		border: var(--sep-w) solid var(--border);
		overflow: hidden;
	}
	.dir {
		display: flex;
		flex-direction: column;
		gap: var(--sp-0);
		height: 100%;
		padding: var(--sp-0) var(--sp-1) var(--sp-1);
		background: var(--dir-bg);
		border: var(--sep-w) solid var(--border-strong);
	}
	.label {
		display: block;
		width: 30%;
		height: var(--sp-0);
		margin: var(--sp-0) 0;
		background: var(--text-faint);
	}
	.panels {
		display: flex;
		gap: var(--sp-1);
		flex: 1;
		min-height: 0;
	}
	.panel {
		display: flex;
		flex-direction: column;
		flex: 3;
		min-width: 0;
		background: var(--bg-panel);
		border: var(--sep-w) solid var(--border);
	}
	.panel + .panel {
		flex: 2;
	}
	.head {
		display: flex;
		align-items: center;
		height: var(--sp-2);
		padding: 0 var(--sp-1);
		background: var(--bg-inset);
		border-bottom: var(--sep-w) solid var(--border);
	}
	.title {
		display: block;
		height: var(--sp-0);
		background: var(--text);
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--sp-0);
		padding: var(--sp-0) 0;
		overflow: hidden;
	}
	.line {
		display: flex;
		gap: var(--sp-0);
		height: var(--sp-0);
		flex: none;
	}
	/* The two colours a change is drawn in, as a band across the line the
	   way the canvas draws one: a step of the panel towards the colour. */
	.line.added {
		background: color-mix(in srgb, var(--added) 45%, var(--bg-panel));
	}
	.line.deleted {
		background: color-mix(in srgb, var(--deleted) 45%, var(--bg-panel));
	}
	.num {
		display: block;
		flex: none;
		width: var(--sp-1);
		margin-left: var(--sp-0);
		background: var(--text-faint);
		opacity: 0.6;
	}
	.code {
		display: flex;
		gap: var(--sp-0);
		flex: 1;
		min-width: 0;
	}
	.seg {
		display: block;
		flex: none;
	}
</style>

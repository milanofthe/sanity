<script lang="ts">
	// The View menu: one row per file type, three states each.
	//
	// The three states exist because a repository is not evenly interesting.
	// Measured on this collection, one docs project carries 2.38 million lines
	// of generated JSON, SVG and notebook output around 61 thousand lines of
	// source. Hiding a type loses the fact that it exists; drawing it in full
	// buries everything else. So a type can be drawn, stubbed, or dropped.
	//
	// Every type starts drawn. There used to be a second section here for
	// types a heuristic had decided were generated output, defaulted to
	// stubbed. The rows are the same control either way, and one list the user
	// sets is better than two where half of them were set for him.
	import Segmented from '$lib/ui/Segmented.svelte';
	import Switch from '$lib/ui/Switch.svelte';
	import { familyOf } from '$lib/canvas/language';
	import { project, VIEW_MODES, type ViewMode } from '$lib/state/project.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { history } from '$lib/state/history.svelte';

	const n = (v: number) => v.toLocaleString('en-US');

	/** Switching the ignored files on or off means another scan, which only
	 *  the app knows how to run. */
	let { onignored }: { onignored?: (on: boolean) => void } = $props();

	/** The mode a set of rows agrees on, or '' when they differ. A control
	 *  showing one of several states as selected would be a lie. */
	const groupMode = (rows: { mode: ViewMode }[]): ViewMode | '' => {
		if (rows.length === 0) return '';
		const first = rows[0].mode;
		return rows.every((r) => r.mode === first) ? first : '';
	};
	const share = (lines: number) =>
		project.totalLines > 0 ? lines / project.totalLines : 0;

	/**
	 * The theme colour of a file type's language family.
	 *
	 * The same six data hues the canvas tints with at the outermost zoom, so
	 * this list is the legend for that: a directory of YAML reads as a
	 * different kind of thing there, and this says which kind. A type nothing
	 * claims, and the folded `other` row, take the faint text colour rather
	 * than a hue they do not have.
	 */
	const familyColour = (lang: number | undefined) => {
		const family = familyOf(lang ?? 0);
		return family >= 0 && (lang ?? 0) > 0
			? `var(--data-${family + 1})`
			: 'var(--reduced-ink)';
	};
</script>

<div class="picker">
	{#if project.groups.length === 0}
		<p class="empty">No project open.</p>
	{:else}
		<div class="head">
			<span class="col-name">Type</span>
			<span class="col-num">Files</span>
			<span class="col-num">Lines</span>
			<span class="col-mode"></span>
		</div>

		{#each project.groups as g (g.id)}
			<div
				class="row"
				class:tinted={ui.tintLanguages}
				style:--share={`${(share(g.lines) * 100).toFixed(1)}%`}
				style:--family={familyColour(g.lang)}
			>
				<span class="col-name">
					<span class="name">{g.id}</span>
					{#if g.id === 'other'}
						<span class="why">under 0.5%</span>
					{/if}
				</span>
				<span class="col-num">{n(g.files)}</span>
				<span class="col-num">{n(g.lines)}</span>
				<span class="col-mode">
					<Segmented
						options={VIEW_MODES}
						value={g.mode}
						onchange={(m: ViewMode) => project.setMode(g.id, m)}
					/>
				</span>
			</div>
		{/each}

		<div class="foot">
			<!-- A sentence, not a label, so it spans the three columns the rows
			     use for a type and its counts. -->
			<span class="summary">
				drawing <b>{n(project.shownLines)}</b> of {n(project.totalLines)} lines
			</span>
			<span class="col-mode">
				<Segmented
					options={VIEW_MODES}
					value={groupMode(project.groups)}
					onchange={(m: ViewMode) => project.setAll(m)}
				/>
			</span>
		</div>

		<div class="options">
			<Switch
				checked={ui.tintLanguages}
				label="Tint by language at the outermost zoom"
				onchange={() => ui.setTintLanguages(!ui.tintLanguages)}
			/>
			<Switch
				checked={ui.dirLabels}
				label="Name directories over the canvas"
				onchange={() => ui.setDirLabels(!ui.dirLabels)}
			/>
			<Switch
				checked={ui.expandDocuments}
				label="Expand documents to all their pages"
				onchange={() => ui.setExpandDocuments(!ui.expandDocuments)}
			/>
			{#if history.commits.length > 0}
				<Switch
					checked={ui.historyFollow}
					label="Fit the view to each step through the history"
					onchange={() => ui.setHistoryFollow(!ui.historyFollow)}
				/>
			{/if}
			{#if project.ignoredTotal > 0 || project.includeIgnored}
				<Switch
					checked={project.includeIgnored}
					disabled={project.demo || project.synthetic}
					label="Show the {n(project.ignoredTotal)} files git ignores"
					onchange={(on: boolean) => onignored?.(on)}
				/>
				{#if project.includeIgnored}
					<span class="why">
						as placeholders, their contents are not read{project.ignoredShown <
						project.ignoredTotal
							? `, first ${n(project.ignoredShown)} of them`
							: ''}
					</span>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	/* No horizontal padding on the container: the rules between sections have
	   to reach the sheet's edges, and a padded container cannot let them. The
	   padding lives on the rows instead, at the same --sp-3 the menu items
	   use, so a dropdown's contents line up whichever kind it is. */
	.picker {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
	}
	.empty {
		color: var(--text-faint);
		padding: var(--sp-2) var(--sp-2);
		margin: 0;
	}
	/* One template for the header and the rows, with the mode column at a
	   fixed width. It used to be `auto`, which resolved to the width of the
	   segmented control in a row and to zero in the header, where that cell is
	   empty: the column headings sat well left of the numbers they labelled. */
	/* The switches at the bottom. One row each, at the same height and the
	   same padding as every other row above them, so the sheet reads as one
	   list rather than as a table with a panel bolted underneath. The rule
	   above them is the same hairline that separates the header. */
	.options {
		border-top: var(--sep-w) solid var(--border);
		padding: var(--sp-1) 0;
		color: var(--text-dim);
	}
	.options :global(.switch) {
		min-height: var(--h-row);
		padding: 0 var(--sp-3);
	}
	.options .why {
		display: block;
		padding: 0 var(--sp-3) var(--sp-1);
		white-space: normal;
		font-size: var(--fs-xs);
	}
	.head,
	.row,
	.foot {
		display: grid;
		grid-template-columns: minmax(0, 1fr) var(--w-count) var(--w-lines) var(--w-mode);
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--row-h);
		padding: 0 var(--sp-3);
	}
	.picker {
		/* The two number columns. Wide enough for a six figure line count at
		   the monospace size the numbers are set in, which is the widest
		   thing either of them ever holds. */
		--w-count: calc(5 * var(--sp-3));
		--w-lines: calc(6 * var(--sp-3));
	}
	/* The column headings are one label each, so they share one style. The
	   `.col-num` rule below also matched them, which put FILES and LINES in
	   monospace at a larger size than TYPE beside them. */
	/* Column headings and section headings are labels, so they share the one
	   style of the row they sit in. Without this the `.col-num` rule for the
	   data rows also matched them, which put the numbers in monospace at a
	   larger size than the label beside them. */
	.head > span,
	.foot > .summary {
		font-family: inherit;
		font-size: inherit;
		font-weight: inherit;
		letter-spacing: inherit;
		color: inherit;
	}
	.head {
		font-family: var(--font-ui);
		font-size: var(--fs-xxs);
		font-weight: 600;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--text-faint);
		border-bottom: var(--sep-w) solid var(--border);
		padding-bottom: var(--sp-1);
	}
	.col-name {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.name {
		font-family: var(--font-mono);
		font-size: var(--fs-s);
		color: var(--text);
	}
	/* Share of the repository, as a fill behind the type name only.
	   Spanning the whole row put a hard vertical edge through the file and
	   line columns, which read as a broken layout rather than as a bar. */
	.col-name {
		position: relative;
	}
	/* The share of the repository, as a fill behind the type name. */
	.col-name::before {
		content: '';
		position: absolute;
		inset: var(--sp-0) auto var(--sp-0) calc(-1 * var(--sp-1));
		width: var(--share);
		/* A floor, so a type with half a percent of the repository still shows
		   its colour once the tint is on: a legend entry you cannot see is not
		   one. */
		min-width: var(--sp-2);
		max-width: calc(100% + 2 * var(--sp-1));
		background: var(--bg-active);
		z-index: 0;
	}
	/* With the tint on, that same bar carries the colour the canvas paints
	   this language family in, which makes the list the legend for it. Held
	   well under full strength, since it sits behind the type's name and a bar
	   you have to read through is a bar in the way. Off, the bar is a neutral
	   fill again: a colour that means nothing on the canvas should not be
	   sitting in the menu claiming to. */
	.tinted .col-name::before {
		background: var(--family);
		opacity: 0.4;
	}
	.col-name > * {
		position: relative;
		z-index: 1;
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.why {
		font-family: var(--font-ui);
		font-size: var(--fs-xxs);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.col-num {
		text-align: right;
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
	}
	/* The total, under a rule. Padded on both sides of the text rather than
	   only above it: with the row's min-height doing the spacing the line sat
	   hard against the bottom edge, which reads as a clipped row. */
	.foot {
		border-top: var(--sep-w) solid var(--border);
		margin-top: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		color: var(--text-dim);
		font-size: var(--fs-xs);
	}
	.summary {
		/* Across the type and count columns, so the sentence is not wrapped
		   into the width of one of them. */
		grid-column: 1 / 4;
		white-space: nowrap;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.foot b {
		color: var(--text);
	}
	.col-mode {
		display: flex;
		justify-content: flex-end;
	}

</style>

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
	import { project, VIEW_MODES, type ViewMode } from '$lib/state/project.svelte';

	const n = (v: number) => v.toLocaleString('en-US');

	/** The mode a set of rows agrees on, or '' when they differ. A control
	 *  showing one of several states as selected would be a lie. */
	const groupMode = (rows: { mode: ViewMode }[]): ViewMode | '' => {
		if (rows.length === 0) return '';
		const first = rows[0].mode;
		return rows.every((r) => r.mode === first) ? first : '';
	};
	const share = (lines: number) =>
		project.totalLines > 0 ? lines / project.totalLines : 0;
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
			<div class="row" style:--share={`${(share(g.lines) * 100).toFixed(1)}%`}>
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
	.head,
	.row,
	.foot {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 52px 74px var(--mode-w);
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--row-h);
		padding: 0 var(--sp-3);
	}
	.picker {
		/* Width of the Full / Stub / Off control, so the header can reserve
		   the same column. */
		--mode-w: 116px;
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
		letter-spacing: 0.09em;
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
	.col-name::before {
		content: '';
		position: absolute;
		inset: 2px auto 2px -4px;
		width: var(--share);
		max-width: calc(100% + 8px);
		background: var(--bg-active);
		z-index: 0;
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
	.foot {
		border-top: var(--sep-w) solid var(--border);
		margin-top: var(--sp-2);
		padding-top: var(--sp-2);
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

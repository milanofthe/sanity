<script lang="ts">
	// The View menu: one row per file type, three states each.
	//
	// The three states exist because a repository is not evenly interesting.
	// Measured on this collection, one docs project carries 2.38 million lines
	// of generated JSON, SVG and notebook output around 61 thousand lines of
	// source. Hiding the artefacts loses the fact that they exist; drawing them
	// in full buries everything else. So a type can be drawn, stubbed, or
	// dropped, and artefacts default to stubbed.
	import Segmented from '$lib/ui/Segmented.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { project, VIEW_MODES, type ViewMode } from '$lib/state/project.svelte';

	const n = (v: number) => v.toLocaleString('en-US');
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

		{#each project.code as g (g.id)}
			<div class="row" style:--share={`${(share(g.lines) * 100).toFixed(1)}%`}>
				<span class="col-name">
					<span class="name">{g.id}</span>
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

		{#if project.artefacts.length > 0}
			<div class="group-head">
				<span>Generated</span>
				<span class="actions">
					<Button title="Stub every generated type" onclick={() => project.setAll('reduced', 'artefacts')}>
						Stub all
					</Button>
					<Button title="Leave every generated type out" onclick={() => project.setAll('off', 'artefacts')}>
						Off
					</Button>
				</span>
			</div>
			{#each project.artefacts as g (g.id)}
				<div class="row artefact" style:--share={`${(share(g.lines) * 100).toFixed(1)}%`}>
					<span class="col-name">
						<span class="name">{g.id}</span>
						<span class="why">{g.artefact}</span>
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
		{/if}

		<div class="foot">
			<span>
				drawing <b>{n(project.shownLines)}</b> of {n(project.totalLines)} lines
			</span>
			<span class="actions">
				<Button onclick={() => project.setAll('full', 'code')}>All code</Button>
				<Button onclick={() => project.setAll('full')}>Everything</Button>
			</span>
		</div>
	{/if}
</div>

<style>
	.picker {
		padding: 0 var(--sp-2);
		font: 500 var(--fs-s) var(--font-ui);
	}
	.empty {
		color: var(--text-faint);
		padding: var(--sp-2) var(--sp-2);
		margin: 0;
	}
	.head,
	.row,
	.foot,
	.group-head {
		display: grid;
		grid-template-columns: 1fr 48px 70px auto;
		align-items: center;
		gap: var(--sp-2);
		padding: 3px var(--sp-2);
	}
	.head {
		font: 600 var(--fs-xxs) var(--font-ui);
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
		font: 500 var(--fs-s) var(--font-mono);
		color: var(--text);
	}
	/* Share of the repository as a fill behind the row, so the list reads as a
	   distribution at a glance. A separate bar next to the name read as a
	   dash and competed with the numbers. */
	.row {
		background: linear-gradient(
			to right,
			var(--bg-active) 0 var(--share),
			transparent var(--share) 100%
		);
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.artefact .name {
		color: var(--text-dim);
	}
	.why {
		font: 400 var(--fs-xxs) var(--font-ui);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.col-num {
		text-align: right;
		font: 400 var(--fs-xs) var(--font-mono);
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
	}
	.group-head {
		grid-template-columns: 1fr auto;
		border-top: var(--sep-w) solid var(--border);
		margin-top: var(--sp-2);
		padding-top: var(--sp-2);
		font: 600 var(--fs-xxs) var(--font-ui);
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.foot {
		grid-template-columns: 1fr auto;
		border-top: var(--sep-w) solid var(--border);
		margin-top: var(--sp-2);
		padding-top: var(--sp-2);
		color: var(--text-dim);
		font-size: var(--fs-xs);
	}
	.foot b {
		color: var(--text);
	}
	.actions {
		display: inline-flex;
		gap: var(--sp-1);
		justify-content: flex-end;
	}
</style>

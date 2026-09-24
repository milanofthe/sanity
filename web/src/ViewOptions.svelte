<script lang="ts">
	// The View menu: how the canvas draws what the Files menu lets through.
	//
	// It used to be the bottom of the file type table, which put settings for
	// the whole canvas under a list of file types, and by the time there were
	// five of them the menu was taller than a laptop screen was useful for.
	import MenuSection from '$lib/ui/MenuSection.svelte';
	import Switch from '$lib/ui/Switch.svelte';
	import { history } from '$lib/state/history.svelte';
	import { ui } from '$lib/state/ui.svelte';
</script>

<MenuSection title="Canvas">
	<div class="options">
		<Switch
			checked={ui.tintLanguages}
			label="Tint by language when zoomed out"
			onchange={() => ui.setTintLanguages(!ui.tintLanguages)}
		/>
		<Switch
			checked={ui.dirLabels}
			label="Name directories over the canvas"
			onchange={() => ui.setDirLabels(!ui.dirLabels)}
		/>
		<Switch
			checked={ui.expandDocuments}
			label="Show every page of a document"
			onchange={() => ui.setExpandDocuments(!ui.expandDocuments)}
		/>
	</div>
</MenuSection>
{#if history.commits.length > 0}
	<MenuSection title="History">
		<div class="options">
			<Switch
				checked={ui.historyFollow}
				label="Fit the project on each step"
				onchange={() => ui.setHistoryFollow(!ui.historyFollow)}
			/>
		</div>
	</MenuSection>
{/if}

<style>
	/* One row each, at the height and padding of every other row in a menu. */
	.options {
		font-family: var(--font-ui);
		font-size: var(--fs-s);
		font-weight: 500;
		color: var(--text-dim);
	}
	.options :global(.switch) {
		min-height: var(--h-row);
		padding: 0 var(--sp-3);
	}
</style>

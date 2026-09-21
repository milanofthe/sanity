<script lang="ts">
	// Three colour chips previewing a theme.
	//
	// Its own component rather than markup passed into MenuItem as a snippet:
	// a snippet's styles belong to the component that defines it, which puts
	// the CSS a long way from where it applies and makes it easy to lose.
	let { colors }: { colors: string[] } = $props();
</script>

<span class="swatches" aria-hidden="true">
	{#each colors as c, i (i)}<i style:background={c}></i>{/each}
</span>

<style>
	.swatches {
		display: inline-flex;
		gap: 2px;
		flex: none;
	}
	i {
		width: 8px;
		height: 8px;
		display: block;
		border: var(--sep-w) solid var(--border);
	}
</style>

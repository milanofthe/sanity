<script lang="ts">
	// Mounts the WebGL canvas and nothing else. Every rendering concern lives
	// in lib/canvas; this component only owns the two elements and the
	// lifecycle, so the renderer never learns that Svelte exists.
	import { onMount } from 'svelte';
	import { CanvasApp, type CanvasStats } from '$lib/canvas/app';

	let { app = $bindable(), onstats }: {
		app?: CanvasApp;
		onstats?: (s: CanvasStats) => void;
	} = $props();

	let canvas: HTMLCanvasElement;
	let labelHost: HTMLDivElement;

	onMount(() => {
		const instance = new CanvasApp(canvas, labelHost);
		if (onstats) instance.onStats = onstats;
		app = instance;
		return () => instance.destroy();
	});
</script>

<div class="stage">
	<canvas bind:this={canvas}></canvas>
	<div class="labels" bind:this={labelHost}></div>
</div>

<style>
	.stage {
		position: relative;
		overflow: hidden;
		background: var(--canvas-bg);
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
		touch-action: none;
		z-index: var(--z-canvas);
	}
	canvas:active {
		cursor: grabbing;
	}
	.labels {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
		z-index: var(--z-labels);
	}
</style>

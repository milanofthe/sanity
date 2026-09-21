<script lang="ts">
	// Mounts the WebGL canvas and nothing else. Every rendering concern lives
	// in lib/canvas; this component only owns the two elements and the
	// lifecycle, so the renderer never learns that Svelte exists.
	import { onMount } from 'svelte';
	import { CanvasApp, type CanvasStats } from '$lib/canvas/app';

	let { app = $bindable(), onstats, onhover, onopenfile, oncontextmenu }: {
		app?: CanvasApp;
		onstats?: (s: CanvasStats) => void;
		onhover?: (path: string | null) => void;
		onopenfile?: (path: string) => void;
		oncontextmenu?: (at: { x: number; y: number; path: string | null }) => void;
	} = $props();

	let canvas: HTMLCanvasElement;

	onMount(() => {
		const instance = new CanvasApp(canvas);
		if (onstats) instance.onStats = onstats;
		if (onhover) instance.onHover = onhover;
		if (onopenfile) instance.onOpenFile = onopenfile;
		if (oncontextmenu) instance.onContextMenu = oncontextmenu;
		app = instance;
		return () => instance.destroy();
	});
</script>

<div class="stage">
	<canvas bind:this={canvas}></canvas>
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
</style>

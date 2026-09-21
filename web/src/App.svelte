<script lang="ts">
	// The shell: toolbar, canvas, status bar. Holds the wiring between the
	// chrome's state and the canvas, and nothing else.
	import Toolbar from './Toolbar.svelte';
	import Canvas from './Canvas.svelte';
	import StatusBar from './StatusBar.svelte';
	import type { CanvasApp, CanvasStats } from '$lib/canvas/app';
	import { project } from '$lib/state/project.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { openSynthetic } from '$lib/sources/synthetic';

	let app = $state<CanvasApp | undefined>();
	let stats = $state<CanvasStats | null>(null);

	// Re-open the scene whenever the set of drawn types changes. The layout is
	// a pure function of the file list, so this is the whole implementation of
	// the view picker: change what is in the list and lay it out again.
	let modeKey = $derived(project.groups.map((g) => `${g.id}:${g.mode}`).join(','));

	$effect(() => {
		if (!app || !modeKey) return;
		openSynthetic(app);
	});

	// The canvas resolves its colours from CSS, so a theme switch has to tell
	// it to read them again.
	$effect(() => {
		// Reading the theme is what subscribes this effect to it.
		ui.theme;
		app?.refreshTheme();
	});

	$effect(() => {
		// Nothing is open on first paint: show generated data so the app has
		// something to be, until the Tauri folder picker lands.
		if (app && project.groups.length === 0) openSynthetic(app, true);
	});

	function onKeyDown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === 'f') app?.fit();
		if (e.key === 'Escape') ui.openMenu = null;
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<Toolbar
	onfit={() => app?.fit()}
	onopen={() => {
		// Replaced by the Tauri dialog; until then a new synthetic repo.
		if (app) openSynthetic(app, true);
	}}
/>
<Canvas bind:app onstats={(s) => (stats = s)} />
<StatusBar {stats} />

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
	import {
		inTauri, initialRepo, loadRepo, loadedRoot, openInEditor, openLoaded, pickFolder,
	} from '$lib/sources/tauri';

	let app = $state<CanvasApp | undefined>();
	let stats = $state<CanvasStats | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Re-open the scene whenever the set of drawn types changes. The layout is
	// a pure function of the file list, so this is the whole implementation of
	// the view picker: change what is in the list and lay it out again.
	let modeKey = $derived(project.groups.map((g) => `${g.id}:${g.mode}`).join(','));

	function rebuild() {
		if (!app) return;
		if (loadedRoot()) openLoaded(app);
		else openSynthetic(app);
	}

	$effect(() => {
		if (!app || !modeKey) return;
		rebuild();
	});

	async function openFolder(path?: string) {
		if (!app || busy) return;
		if (!inTauri()) {
			// In a plain browser tab there is no folder to open, so the Project
			// menu draws a fresh synthetic repo instead of doing nothing.
			openSynthetic(app, true);
			return;
		}
		const target = path ?? (await pickFolder());
		if (!target) return;
		busy = true;
		error = null;
		try {
			await loadRepo(target);
			rebuild();
			app.fit();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	// The canvas resolves its colours from CSS, so a theme switch has to tell
	// it to read them again.
	$effect(() => {
		// Reading the theme is what subscribes this effect to it.
		ui.theme;
		app?.refreshTheme();
	});

	let started = false;
	$effect(() => {
		if (!app || started) return;
		started = true;
		// A folder from the command line wins; otherwise show generated data so
		// the window has something to be before one is chosen.
		initialRepo().then((path) => {
			if (path) openFolder(path);
			else if (app && project.groups.length === 0) openSynthetic(app, true);
		});
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
	onopen={() => openFolder()}
	onreload={(path) => openFolder(path)}
	{busy}
/>
<Canvas
	bind:app
	onstats={(s) => (stats = s)}
	onopenfile={(path) => {
		// Clicking a panel header opens the file. Only meaningful with a real
		// repository behind it, so it is a no-op on synthetic data.
		if (!inTauri() || !loadedRoot()) return;
		openInEditor(path).catch((e) => {
			error = e instanceof Error ? e.message : String(e);
		});
	}}
/>
<StatusBar {stats} {error} />

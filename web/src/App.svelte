<script lang="ts">
	// The shell: toolbar, canvas, status bar. Holds the wiring between the
	// chrome's state and the canvas, and nothing else.
	import Toolbar from './Toolbar.svelte';
	import ContextMenu from '$lib/ui/ContextMenu.svelte';
	import MenuItem from '$lib/ui/MenuItem.svelte';
	import MenuSection from '$lib/ui/MenuSection.svelte';
	import Canvas from './Canvas.svelte';
	import StatusBar from './StatusBar.svelte';
	import type { CanvasApp, CanvasStats } from '$lib/canvas/app';
	import { project } from '$lib/state/project.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { openSynthetic } from '$lib/sources/synthetic';
	import {
		fixtureLoaded, fixtureName, loadFixture, openFixture,
	} from '$lib/sources/fixture';
	import {
		inTauri, loadRepo, loadedRoot, openInEditor, openLoaded, pickFolder, setBaseline,
		startup, stopWatching, watchRepo,
	} from '$lib/sources/tauri';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { bandsFromQuery, setBands } from '$lib/canvas/lod';

	let app = $state<CanvasApp | undefined>();
	let stats = $state<CanvasStats | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let ctx = $state<{ x: number; y: number; path: string | null } | null>(null);
	/** The running watch, so opening another folder replaces it. */
	let unwatch: UnlistenFn | null = null;

	const fileName = (p: string) => p.split('/').pop() ?? p;

	function openFile(path: string) {
		if (!inTauri() || !loadedRoot()) return;
		openInEditor(path).catch((e) => {
			error = e instanceof Error ? e.message : String(e);
		});
	}

	// Re-open the scene whenever the set of drawn types changes. The layout is
	// a pure function of the file list, so this is the whole implementation of
	// the view picker: change what is in the list and lay it out again.
	let modeKey = $derived(project.groups.map((g) => `${g.id}:${g.mode}`).join(','));

	/**
	 * Lay the scene out again.
	 *
	 * Keeps the camera by default. Fitting belongs to opening a project, not to
	 * rebuilding a scene: a watcher-driven relayout used to fly the view back
	 * to the whole project on every save, which made the live updates unusable
	 * for the thing they are for.
	 */
	function rebuild(keepView = true) {
		if (!app) return;
		if (fixtureLoaded()) openFixture(app, keepView);
		else if (loadedRoot()) openLoaded(app, keepView);
		else openSynthetic(app, false, keepView);
	}

	// Only when the picker's own key actually changed. The groups array is
	// rebuilt whenever the watcher adds a file, and reacting to that reference
	// rather than to its content meant a save cost a second full layout.
	let lastModeKey = '';
	$effect(() => {
		if (!app || !modeKey) return;
		if (modeKey === lastModeKey) return;
		lastModeKey = modeKey;
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
			// Stop the previous watch before the scan, or events for the folder
			// being replaced would arrive against the new file list.
			unwatch?.();
			unwatch = null;
			await stopWatching();

			await loadRepo(target);
			// A fresh project is fitted; everything after this keeps the view.
			lastModeKey = project.groups.map((g) => `${g.id}:${g.mode}`).join(',');
			rebuild(false);
			app.fit();
			// Watching is what makes this a monitor rather than a snapshot, so
			// it starts with the folder. A folder that cannot be watched is
			// still viewable, which is why this does not fail the open.
			unwatch = await watchRepo(app).catch((e) => {
				console.warn('watch failed', e);
				return null;
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	$effect(() => () => {
		unwatch?.();
		unwatch = null;
		void stopWatching();
	});

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
		const fixture = fixtureName();
		if (fixture) {
			busy = true;
			loadFixture(fixture)
				.then(() => {
					rebuild(false);
					app?.fit();
				})
				.catch((e) => (error = e instanceof Error ? e.message : String(e)))
				.finally(() => (busy = false));
			return;
		}
		startup().then((s) => {
			// SANITY_LOD uses the same form as ?lod=, so one parser serves both.
			const bands = s.lod ? bandsFromQuery(`?lod=${s.lod}`) : null;
			if (bands) setBands(bands);
			if (s.repo) openFolder(s.repo);
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
	onbaseline={(b) => {
		if (app) setBaseline(app, b).catch((e) => (error = e instanceof Error ? e.message : String(e)));
	}}
	{busy}
/>
<Canvas
	bind:app
	onstats={(s) => (stats = s)}
	onopenfile={openFile}
	oncontextmenu={(at) => (ctx = at)}
/>
<StatusBar {stats} {error} />

<ContextMenu x={ctx?.x ?? 0} y={ctx?.y ?? 0} open={ctx !== null} onclose={() => (ctx = null)}>
	{#if ctx?.path}
		<MenuSection title={fileName(ctx.path)} verbatim>
			<MenuItem
				label="Fit to view"
				icon="fit"
				onclick={() => {
					if (ctx?.path) app?.focusFile(ctx.path);
					ctx = null;
				}}
			/>
			<MenuItem
				label="Open in editor"
				icon="external"
				disabled={!inTauri() || !loadedRoot()}
				onclick={() => {
					if (ctx?.path) openFile(ctx.path);
					ctx = null;
				}}
			/>
			<MenuItem
				label="Copy path"
				icon="copy"
				onclick={() => {
					if (ctx?.path) navigator.clipboard?.writeText(ctx.path);
					ctx = null;
				}}
			/>
		</MenuSection>
	{/if}
	<MenuSection>
		<MenuItem
			label="Fit project"
			icon="fit"
			hint="f"
			onclick={() => {
				app?.fit();
				ctx = null;
			}}
		/>
	</MenuSection>
</ContextMenu>

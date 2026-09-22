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
	import { openSynthetic, syntheticQuery } from '$lib/sources/synthetic';
	import {
		fixtureLoaded, fixtureName, loadFixture, openFixture,
	} from '$lib/sources/fixture';
	import {
		demoName, loadDemoIndex, rememberDemo, type DemoRepo,
	} from '$lib/sources/demo';
	import {
		inTauri, loadRepo, loadedRoot, openInEditor, openLoaded, pickFolder,
		startup, stopWatching, watchRepo,
	} from '$lib/sources/tauri';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { bandsFromQuery, setBands } from '$lib/canvas/lod';
	import { IMAGE_HEIGHT, IMAGE_WIDTH, saveImage } from '$lib/image';

	let app = $state<CanvasApp | undefined>();
	let stats = $state<CanvasStats | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let ctx = $state<{ x: number; y: number; path: string | null } | null>(null);
	/** The repositories this build has a dump of, empty in the desktop app. */
	let demos = $state<DemoRepo[]>([]);
	/** One line about something that just happened, such as where an image was
	 *  written. Errors have their own slot; this is for the good news. */
	let notice = $state<string | null>(null);
	let noticeTimer = 0;

	/** Say something in the status bar. `hold` of 0 leaves it until replaced,
	 *  which is what a job still running needs. */
	function say(message: string | null, hold = 6000) {
		notice = message;
		clearTimeout(noticeTimer);
		if (message && hold > 0) {
			noticeTimer = setTimeout(() => (notice = null), hold) as unknown as number;
		}
	}

	/**
	 * Write the canvas to a PNG.
	 *
	 * Takes a second or two at 4K, most of it in the PNG encoder, and the
	 * canvas is unusable while it runs because the export borrows its drawing
	 * buffer. So it says what it is doing first and what came of it after.
	 */
	async function save(region: 'view' | 'project') {
		if (!app) return;
		say(`rendering up to ${IMAGE_WIDTH} x ${IMAGE_HEIGHT}…`, 0);
		try {
			const to = await saveImage(app, region);
			say(to ? `wrote ${to}` : 'not saved');
		} catch (e) {
			say(null);
			error = e instanceof Error ? e.message : String(e);
		}
	}
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
		// A rebuild replaces the scene, and with it what it knows about the
		// query. Without this, a save while searching left the field filled and
		// the canvas unfiltered.
		if (query) onSearch(query);
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

	/**
	 * Show one of the baked-in repositories.
	 *
	 * The same path a fixture takes, which is the point: the demo is not a
	 * second renderer with its own quirks, it is this app with a folder that
	 * arrives over HTTP. The root is set to the repository's own name, since
	 * the path the dump was made from belongs to the build machine.
	 */
	async function openDemo(id: string) {
		if (!app || busy) return;
		busy = true;
		error = null;
		try {
			await loadFixture(`demo/${id}`, { root: id, demo: true });
			lastModeKey = project.groups.map((g) => `${g.id}:${g.mode}`).join(',');
			rebuild(false);
			app.fit();
			rememberDemo(id);
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

	// The language tint, which the renderer keeps across a reopen.
	$effect(() => {
		app?.setLanguageTint(ui.tintLanguages);
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
		// A query that asks for a generated repository of a given shape wins
		// over everything: that is how the layout check drives its cases.
		if (syntheticQuery()) {
			openSynthetic(app, true);
			return;
		}
		// In a browser there is no folder to open, so the demo build shows one
		// of its repositories: the one that was linked to, or the first.
		if (!inTauri()) {
			void loadDemoIndex().then((list) => {
				demos = list;
				if (list.length > 0) return openDemo(demoName() ?? list[0].id);
				if (app) openSynthetic(app, true);
			});
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

	// Search state lives here because the toolbar has the field and the canvas
	// has the panels: one of them has to own it, and this is where both are.
	let hover = $state<string | null>(null);
	let query = $state('');
	let matches = $state(0);
	let hitShown = $state(0);
	let hitTotal = $state(0);
	let hitFiles = $state(0);
	let at = $state(0);
	let toolbar: ReturnType<typeof Toolbar> | null = $state(null);
	let findTimer = 0;

	// Names and then text hits, in one list and one counter: the field says how
	// many places the query names, and Enter walks them in that order.
	const stepCount = $derived(matches + hitShown);
	const shownCount = $derived(matches + hitTotal);
	const searchNote = $derived(
		[
			matches > 0 ? `${matches} ${matches === 1 ? 'file' : 'files'} by name` : '',
			hitTotal > 0 ? `${hitTotal} in the text of ${hitFiles} ${hitFiles === 1 ? 'file' : 'files'}` : '',
			hitTotal > hitShown ? `first ${hitShown} of them steppable` : ''
		]
			.filter(Boolean)
			.join(', ')
	);

	/** Debounce before the text search, in ms. A keystroke reads the whole
	 *  repository, which is 7 to 8 ms in the backend, but a burst of typing
	 *  should not queue eight of them. */
	const FIND_DELAY = 140;

	function onSearch(q: string) {
		query = q;
		matches = app?.search(q).length ?? 0;
		// Back to the first match on every keystroke: the ranking changed, so a
		// position in the old list means nothing in the new one.
		at = 0;
		hitShown = 0;
		hitTotal = 0;
		hitFiles = 0;
		clearTimeout(findTimer);
		if (!q) return;
		findTimer = setTimeout(() => {
			void app?.findText(q).then((r) => {
				if (!r || r.stale || q !== query) return;
				hitShown = r.shown;
				hitTotal = r.total;
				hitFiles = r.files;
			});
		}, FIND_DELAY) as unknown as number;
	}

	/** Step through the hits, flying to each. */
	function step(by: number) {
		if (!app || stepCount === 0) return;
		const next = at === 0 && by > 0 ? 1 : at + by;
		const wrapped = ((next - 1 + stepCount) % stepCount) + 1;
		at = wrapped;
		app.focusMatch(wrapped - 1);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement) return;
		// Slash and the platform's find key both land in the query field, which
		// is where every other tool on this machine puts them.
		if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) {
			e.preventDefault();
			toolbar?.focusSearch();
			return;
		}
		if (e.key === 'f') app?.fit();
		if (e.key === 'Escape') {
			ui.openMenu = null;
			if (query) onSearch('');
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<Toolbar
	bind:this={toolbar}
	onopen={() => openFolder()}
	onreload={(path) => openFolder(path)}
	ondemo={(id) => openDemo(id)}
	{demos}
	onsearch={onSearch}
	onnext={() => step(1)}
	onprev={() => step(-1)}
	{query}
	matches={shownCount}
	note={searchNote}
	{at}
	{busy}
/>
<Canvas
	bind:app
	onstats={(s) => (stats = s)}
	onhover={(path) => (hover = path)}
	onopenfile={openFile}
	oncontextmenu={(at) => (ctx = at)}
/>
<StatusBar {stats} {hover} {error} {notice} />

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
	<MenuSection title="Image">
		<MenuItem
			label="Save this view"
			icon="image"
			hint="4K"
			onclick={() => {
				ctx = null;
				void save('view');
			}}
		/>
		<MenuItem
			label="Save whole project"
			icon="image"
			hint="4K"
			onclick={() => {
				ctx = null;
				void save('project');
			}}
		/>
	</MenuSection>
</ContextMenu>

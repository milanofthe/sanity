<script lang="ts">
	// The only chrome that is always visible: the mark and three menus.
	//
	// Project is where a folder comes from, View is what gets drawn, Theme is
	// how it looks. Deliberately three, because a fourth would mean the app has
	// grown a settings problem.
	import Menu from '$lib/ui/Menu.svelte';
	import MenuItem from '$lib/ui/MenuItem.svelte';
	import MenuSection from '$lib/ui/MenuSection.svelte';
	import SanityMark from '$lib/ui/SanityMark.svelte';
	import ThemePreview from '$lib/ui/ThemePreview.svelte';
	import Choice from '$lib/ui/Choice.svelte';
	import Search from '$lib/ui/Search.svelte';
	import Ticker from '$lib/ui/Ticker.svelte';
	import { history } from '$lib/state/history.svelte';
	import FileTypePicker from './FileTypePicker.svelte';
	import ViewOptions from './ViewOptions.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { project } from '$lib/state/project.svelte';
	import { THEMES } from '$lib/theme';
	import type { DemoRepo } from '$lib/sources/demo';
	import { inTauri } from '$lib/sources/tauri';

	let {
		onopen,
		onreload,
		ondemo,
		onignored,
		demos = [],
		onsearch,
		onnext,
		onprev,
		query = '',
		matches = 0,
		note = '',
		at = 0,
		busy = false,
		onhistory
	}: {
		onopen?: () => void;
		onreload?: (path: string) => void;
		ondemo?: (id: string) => void;
		/** The ignored-files switch in the Files menu, which costs a rescan. */
		onignored?: (on: boolean) => void;
		/** Repositories baked into the build, empty in the desktop app. */
		demos?: DemoRepo[];
		onsearch?: (q: string) => void;
		onnext?: () => void;
		onprev?: () => void;
		query?: string;
		matches?: number;
		/** What the count means, for the field's tooltip. */
		note?: string;
		at?: number;
		busy?: boolean;
		/** Send the history ticker to a commit, -1 for the present. */
		onhistory?: (index: number) => void;
	} = $props();

	/** The commit the ticker is on, which the canvas is showing or about to. */
	const ticked = $derived(history.target >= 0 ? history.commits[history.target] : null);
	const when = (t: number) =>
		new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

	let search: ReturnType<typeof Search> | null = $state(null);

	/** Put the caret in the query field, for the keyboard shortcut. */
	export function focusSearch() {
		search?.focus();
	}

	/** Where the app itself lives. The demo is the only place anyone sees it
	 *  without having cloned it first, so it is the one place that has to say
	 *  where it came from. */
	const REPO_URL = 'https://github.com/milanofthe/sanity';

	const short = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
	/** Thousands as k, so a hint stays a hint. */
	const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
	const shown = $derived(demos.find((d) => project.demo && d.id === project.root) ?? null);
	const toggle = (id: 'project' | 'files' | 'view' | 'theme' | 'all') => () =>
		(ui.openMenu = ui.openMenu === id ? null : id);
	const close = () => (ui.openMenu = null);
</script>

<header>
	<div class="brand" title={project.root || 'no project open'}>
		<SanityMark height={15} />
	</div>

	{#snippet projectBody()}
		{#if inTauri() || demos.length === 0}
			<MenuItem
				label={inTauri() ? 'Open folder…' : 'Generated repo'}
				icon="folder"
				disabled={busy}
				onclick={() => {
					ui.openMenu = null;
					onopen?.();
				}}
			/>
		{/if}
		{#if demos.length > 0}
			<MenuSection title="Repositories">
				{#each demos as d (d.id)}
					<MenuItem
						label={d.label}
						hint={`${d.files} files · ${kilo(d.lines)} lines`}
						checked={d.id === shown?.id}
						disabled={busy}
						onclick={() => { ui.openMenu = null; ondemo?.(d.id); }}
					/>
				{/each}
			</MenuSection>
		{/if}
		{#if project.recent.length > 0}
			<MenuSection title="Recent">
				{#each project.recent as path (path)}
					<MenuItem
						label={short(path)}
						hint={path === project.root ? 'open' : ''}
						checked={path === project.root}
						onclick={() => { ui.openMenu = null; onreload?.(path); }}
					/>
				{/each}
			</MenuSection>
		{/if}
		{#if shown}
			<MenuSection title="Showing">
				<div class="path">
					<a href={shown.url} target="_blank" rel="noreferrer">
						{shown.url.replace('https://', '')}
					</a>
				</div>
			</MenuSection>
		{/if}
		{#if demos.length > 0}
			<MenuSection title="sanity">
				<div class="path">
					<a href={REPO_URL} target="_blank" rel="noreferrer">
						{REPO_URL.replace('https://', '')}
					</a>
				</div>
			</MenuSection>
		{/if}
		{#if !shown && project.root}
			<MenuSection title="Open">
				<div class="path">{project.root}</div>
			</MenuSection>
		{/if}
	{/snippet}
	{#snippet themeBody()}
		<div class="themes" class:narrow={ui.narrow}>
			{#each THEMES as t (t.id)}
				<Choice label={t.label} checked={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
					<ThemePreview theme={t.id} />
				</Choice>
			{/each}
		</div>
	{/snippet}

	{#if ui.narrow}
		<!-- A phone's width: the four menus one under the other in one sheet
		     as wide as the screen, since four triggers and a search field do
		     not fit across it. -->
		<Menu label="Menu" full open={ui.openMenu === 'all'} ontoggle={toggle('all')} onclose={close}>
			{@render projectBody()}
			<MenuSection title="Files">
				<FileTypePicker onignored={(on: boolean) => onignored?.(on)} />
			</MenuSection>
			<ViewOptions />
			<MenuSection title="Theme">
				{@render themeBody()}
			</MenuSection>
		</Menu>
	{:else}
		<Menu
			label="Project"
			open={ui.openMenu === 'project'}
			ontoggle={toggle('project')}
			onclose={close}
		>
			{@render projectBody()}
		</Menu>

		<Menu
			label="Files"
			width="var(--w-menu-l)"
			open={ui.openMenu === 'files'}
			ontoggle={toggle('files')}
			onclose={close}
		>
			<FileTypePicker onignored={(on: boolean) => onignored?.(on)} />
		</Menu>

		<Menu
			label="View"
			width="var(--w-menu-m)"
			open={ui.openMenu === 'view'}
			ontoggle={toggle('view')}
			onclose={close}
		>
			<ViewOptions />
		</Menu>

		<Menu
			label="Theme"
			width="auto"
			open={ui.openMenu === 'theme'}
			ontoggle={toggle('theme')}
			onclose={close}
		>
			{@render themeBody()}
		</Menu>
	{/if}

	<span class="spacer"></span>

	{#if history.commits.length > 0}
		<Ticker
			label={ticked ? ticked.sha.slice(0, 7) : 'now'}
			detail={ticked?.subject ?? ''}
			title={ticked
				? `${ticked.subject}\n${ticked.author}, ${when(ticked.time)}\nthe arrow keys step, click the id for now`
				: `The folder as it is. The left arrow steps back through ${history.commits.length} commits`}
			older={history.target < history.commits.length - 1}
			newer={history.target >= 0}
			present={history.target < 0}
			onolder={() => onhistory?.(history.target + 1)}
			onnewer={() => onhistory?.(history.target - 1)}
			onpresent={() => onhistory?.(-1)}
		/>
	{/if}

	<Search
		bind:this={search}
		value={query}
		count={matches}
		{note}
		{at}
		oninput={(q) => onsearch?.(q)}
		onnext={() => onnext?.()}
		onprev={() => onprev?.()}
		onclear={() => onsearch?.('')}
	/>

	{#if busy}
		<span class="badge busy" title="Scanning">scanning</span>
	{:else if ui.narrow}
		<!-- No room; the Project menu says what is showing. -->
	{:else if project.demo}
		<span class="badge" title="A snapshot of a public repository, read only">demo</span>
	{:else if project.synthetic}
		<span class="badge" title="Showing generated data, not a real repository">synthetic</span>
	{/if}
</header>

<style>
	header {
		display: flex;
		align-items: stretch;
		min-width: 0;
		overflow: visible;
		gap: 0;
		background: var(--bg-panel);
		border-bottom: var(--sep-w) solid var(--border);
		z-index: var(--z-chrome);
		user-select: none;
	}
	.brand {
		display: flex;
		align-items: center;
		padding: 0 var(--sp-3) 0 var(--sp-3);
		border-right: var(--sep-w) solid var(--border);
		margin-right: var(--sp-1);
	}
	.spacer {
		flex: 1;
	}
	/* Four across, so the eight themes are two rows of pictures that can be
	   compared side by side rather than a column to scroll. */
	.themes {
		display: grid;
		grid-template-columns: repeat(4, auto);
		gap: var(--sp-1);
		padding: var(--sp-1);
	}
	/* Two to a row on a phone, where four ran off the screen. */
	.themes.narrow {
		grid-template-columns: repeat(2, auto);
		justify-content: center;
	}
	.path {
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		color: var(--text-faint);
		padding: var(--sp-0) var(--sp-3) var(--sp-1);
		overflow-wrap: anywhere;
	}
	.path a {
		display: block;
		color: var(--accent);
	}
	.badge.busy {
		color: var(--warn);
		border-color: var(--warn);
	}
	.badge {
		align-self: center;
		font-family: var(--font-ui);
		font-size: var(--fs-xxs);
		font-weight: 600;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--accent);
		border: var(--sep-w) solid var(--accent);
		padding: var(--sp-0) var(--sp-2);
		margin-right: var(--sp-2);
	}
	header :global(button) {
		align-self: center;
	}
	header :global(.field) {
		margin-right: var(--sp-3);
	}
</style>

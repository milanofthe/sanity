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
	import Search from '$lib/ui/Search.svelte';
	import FileTypePicker from './FileTypePicker.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { project } from '$lib/state/project.svelte';
	import { THEMES } from '$lib/theme';
	import type { DemoRepo } from '$lib/sources/demo';
	import { inTauri } from '$lib/sources/tauri';

	let {
		onopen,
		onreload,
		ondemo,
		demos = [],
		onsearch,
		onnext,
		onprev,
		query = '',
		matches = 0,
		note = '',
		at = 0,
		busy = false
	}: {
		onopen?: () => void;
		onreload?: (path: string) => void;
		ondemo?: (id: string) => void;
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
	} = $props();

	let search: ReturnType<typeof Search> | null = $state(null);

	/** Put the caret in the query field, for the keyboard shortcut. */
	export function focusSearch() {
		search?.focus();
	}

	const short = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
	/** Thousands as k, so a hint stays a hint. */
	const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
	const shown = $derived(demos.find((d) => project.demo && d.id === project.root) ?? null);
	const toggle = (id: 'project' | 'view' | 'theme') => () =>
		(ui.openMenu = ui.openMenu === id ? null : id);
	const close = () => (ui.openMenu = null);
</script>

<header>
	<div class="brand" title={project.root || 'no project open'}>
		<SanityMark height={15} />
	</div>

	<Menu
		label="Project"
		open={ui.openMenu === 'project'}
		ontoggle={toggle('project')}
		onclose={close}
	>
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
					{shown.about}
					<a href={shown.url} target="_blank" rel="noreferrer">
						{shown.url.replace('https://', '')}
					</a>
				</div>
			</MenuSection>
		{:else if project.root}
			<MenuSection title="Open">
				<div class="path">{project.root}</div>
			</MenuSection>
		{/if}
	</Menu>

	<Menu
		label="View"
		width="440px"
		open={ui.openMenu === 'view'}
		ontoggle={toggle('view')}
		onclose={close}
	>
		<FileTypePicker />
	</Menu>

	<Menu
		label="Theme"
		width="300px"
		open={ui.openMenu === 'theme'}
		ontoggle={toggle('theme')}
		onclose={close}
	>
		{#each THEMES as t (t.id)}
			<MenuItem tall checked={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
				<ThemePreview theme={t.id} />
				{t.label}
			</MenuItem>
		{/each}
	</Menu>

	<span class="spacer"></span>

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
	.path {
		font-family: var(--font-mono);
		font-size: var(--fs-xs);
		color: var(--text-faint);
		padding: 2px var(--sp-3) var(--sp-1);
		overflow-wrap: anywhere;
	}
	.path a {
		display: block;
		margin-top: var(--sp-1);
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
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
		border: var(--sep-w) solid var(--accent);
		padding: 2px 6px;
		margin-right: var(--sp-2);
	}
	header :global(button) {
		align-self: center;
	}
	header :global(.field) {
		margin-right: var(--sp-3);
	}
</style>

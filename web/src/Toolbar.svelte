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
	import Swatches from '$lib/ui/Swatches.svelte';
	import Button from '$lib/ui/Button.svelte';
	import FileTypePicker from './FileTypePicker.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { project } from '$lib/state/project.svelte';
	import { THEMES } from '$lib/theme';

	let {
		onopen,
		onfit,
		onreload,
		onbaseline,
		busy = false
	}: {
		onopen?: () => void;
		onfit?: () => void;
		onreload?: (path: string) => void;
		/** Switch what the change highlighting is measured against. */
		onbaseline?: (baseline: 'head' | 'branch') => void;
		busy?: boolean;
	} = $props();

	const short = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
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
		<MenuItem
			label="Open folder…"
			icon="folder"
			disabled={busy}
			onclick={() => {
				ui.openMenu = null;
				onopen?.();
			}}
		/>
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
		{#if project.root}
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
		{#if project.watching}
			<MenuSection title="Changes against">
				<MenuItem
					label="Uncommitted work"
					hint="HEAD"
					checked={project.baseline === 'head'}
					onclick={() => {
						ui.openMenu = null;
						onbaseline?.('head');
					}}
				/>
				<MenuItem
					label="Everything on this branch"
					hint="merge base"
					checked={project.baseline === 'branch'}
					onclick={() => {
						ui.openMenu = null;
						onbaseline?.('branch');
					}}
				/>
			</MenuSection>
		{/if}
	</Menu>

	<Menu
		label="Theme"
		width="200px"
		open={ui.openMenu === 'theme'}
		ontoggle={toggle('theme')}
		onclose={close}
	>
		{#each THEMES as t (t.id)}
			<MenuItem checked={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
				<Swatches colors={[t.bg, t.panel, t.accent]} />
				{t.label}
			</MenuItem>
		{/each}
	</Menu>

	<span class="spacer"></span>

	{#if busy}
		<span class="badge busy" title="Scanning">scanning</span>
	{:else if project.synthetic}
		<span class="badge" title="Showing generated data, not a real repository">synthetic</span>
	{/if}
	<Button title="Fit the whole project in view (f)" onclick={() => onfit?.()}>Fit</Button>
</header>

<style>
	header {
		display: flex;
		align-items: stretch;
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
</style>

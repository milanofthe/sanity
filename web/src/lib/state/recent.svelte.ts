// The folders opened before, most recent first, and how each was looked at:
// what every file type is drawn as and the switches of the Files and View
// menus. Kept between sessions, so a project opens the way it was left.

import type { ViewMode } from './project.svelte';

const KEY = 'sanity.recent';
const MAX = 8;

export interface Settings {
	/** File types not drawn in full, by group id. */
	modes: Record<string, ViewMode>;
	includeIgnored: boolean;
	tintLanguages: boolean;
	dirLabels: boolean;
	historyFollow: boolean;
	expandDocuments: boolean;
}

interface Entry {
	root: string;
	settings: Settings;
}

function read(): Entry[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((e) => typeof e?.root === 'string' && e.settings) : [];
	} catch {
		return [];
	}
}

class RecentState {
	entries = $state<Entry[]>(read());
	roots = $derived(this.entries.map((e) => e.root));
	/** The folder a change of settings belongs to; empty while the canvas
	 *  shows a demo or generated data, which have no folder to remember. */
	current = '';

	settings(root: string): Settings | undefined {
		return this.entries.find((e) => e.root === root)?.settings;
	}

	/** A folder is on screen, with these settings: to the front. */
	opened(root: string, settings: Settings) {
		this.current = root;
		this.store([{ root, settings }, ...this.entries.filter((e) => e.root !== root)].slice(0, MAX));
	}

	/** Something was switched for the folder on screen. */
	set(patch: Partial<Settings>) {
		if (!this.current) return;
		this.store(
			this.entries.map((e) =>
				e.root === this.current ? { root: e.root, settings: { ...e.settings, ...patch } } : e
			)
		);
	}

	private store(entries: Entry[]) {
		this.entries = entries;
		try {
			localStorage.setItem(KEY, JSON.stringify(entries));
		} catch {
			// A session without storage remembers for as long as it runs.
		}
	}
}

export const recent = new RecentState();

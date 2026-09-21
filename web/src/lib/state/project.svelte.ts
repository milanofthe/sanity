// The open project: which folder, what is in it, and how much of each file
// type to draw.
//
// The three view modes are the reason this state exists. A binary
// include/exclude is not enough for a structural overview: a repository whose
// generated JSON outweighs its source by fifty to one has to be readable
// without pretending the JSON is not there. So a file type can be drawn in
// full, kept as a placeholder that shows the file exists without claiming any
// area proportional to its size, or dropped entirely.

export type ViewMode = 'full' | 'reduced' | 'off';

export const VIEW_MODES: { id: ViewMode; label: string; title: string }[] = [
	{ id: 'full', label: 'Full', title: 'Draw the file contents' },
	{ id: 'reduced', label: 'Stub', title: 'Show that the file exists, without its contents' },
	{ id: 'off', label: 'Off', title: 'Leave the file out of the layout' }
];

export interface FileGroup {
	/** Extension without the dot, or `(none)` for extensionless files. */
	id: string;
	files: number;
	lines: number;
	/** Set by the scan when this group was classified as generated; the string
	 *  is the reason, so the UI can say why rather than just hiding things. */
	mode: ViewMode;
}

/** Groups below this share of the repository are folded into one row, so the
 *  picker does not become a list of forty one-file extensions. */
const MINOR_LINE_SHARE = 0.005;

class ProjectState {
	/** Absolute path of the open folder, or a label in synthetic mode. */
	root = $state<string>('');
	/** Set when the canvas is showing generated data rather than a real repo. */
	synthetic = $state(false);
	groups = $state<FileGroup[]>([]);
	/** Recently opened folders, most recent first. */
	recent = $state<string[]>([]);

	/** True while a file watcher is running on the open folder. Shown in the
	 *  status bar, because the difference between a live view and a snapshot is
	 *  not something you can see by looking at the canvas. */
	watching = $state(false);
	/** Files with a change on screen right now. */
	changed = $state(0);
	/** When the last batch of changes arrived, as a performance timestamp, or
	 *  0 if none has. */
	lastChangeAt = $state(0);

	totalLines = $derived(this.groups.reduce((s, g) => s + g.lines, 0));
	shownLines = $derived(
		this.groups.filter((g) => g.mode === 'full').reduce((s, g) => s + g.lines, 0)
	);
	/** Lines drawn as stubs rather than in full. */
	stubbedLines = $derived(
		this.groups.filter((g) => g.mode === 'reduced').reduce((s, g) => s + g.lines, 0)
	);
	/** Build the picker rows from a scan, defaulting artefacts to placeholders
	 *  rather than to hidden: the point of the mode is that you can see they
	 *  are there. */
	load(root: string, rows: Omit<FileGroup, 'mode'>[], synthetic = false) {
		this.root = root;
		this.synthetic = synthetic;
		const total = rows.reduce((s, r) => s + r.lines, 0) || 1;
		const groups: FileGroup[] = [];
		let minor: FileGroup | null = null;

		for (const r of [...rows].sort((a, b) => b.lines - a.lines)) {
			if (r.lines / total < MINOR_LINE_SHARE) {
				minor ??= { id: 'other', files: 0, lines: 0, mode: 'full' };
				minor.files += r.files;
				minor.lines += r.lines;
				continue;
			}
			groups.push({ ...r, mode: 'full' });
		}
		if (minor && minor.files > 0) groups.push(minor);
		this.groups = groups;

		if (!synthetic && root) {
			this.recent = [root, ...this.recent.filter((r) => r !== root)].slice(0, 8);
		}
	}

	/**
	 * Take a new set of rows while keeping what the user chose.
	 *
	 * Used when the watcher adds or removes a file: the counts move, but a
	 * group the user switched to reduced has to stay reduced. `load` resets
	 * every mode to its default, which is right for opening a project and
	 * wrong for a file being saved.
	 */
	/** Record that a batch of changes arrived, for the status bar. */
	sawChanges(changed: number) {
		this.changed = changed;
		this.lastChangeAt = performance.now();
	}

	refreshGroups(rows: Omit<FileGroup, 'mode'>[]) {
		const chosen = new Map(this.groups.map((g) => [g.id, g.mode]));
		this.load(this.root, rows, this.synthetic);
		for (const g of this.groups) {
			const was = chosen.get(g.id);
			if (was) g.mode = was;
		}
	}

	mode(id: string): ViewMode {
		return this.groups.find((g) => g.id === id)?.mode ?? 'full';
	}

	setMode(id: string, mode: ViewMode) {
		this.groups = this.groups.map((g) => (g.id === id ? { ...g, mode } : g));
	}

	setAll(mode: ViewMode) {
		this.groups = this.groups.map((g) => ({ ...g, mode }));
	}

	/** Mode for a path, by extension. The layout asks this per file. */
	modeForPath(path: string): ViewMode {
		const dot = path.lastIndexOf('.');
		const slash = path.lastIndexOf('/');
		const ext = dot > slash ? path.slice(dot + 1) : '(none)';
		const hit = this.groups.find((g) => g.id === ext);
		if (hit) return hit.mode;
		return this.groups.find((g) => g.id === 'other')?.mode ?? 'full';
	}
}

export const project = new ProjectState();

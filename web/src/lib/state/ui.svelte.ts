// App chrome state: theme, which menu is open, and the view switches that are
// off by default. Small, but shared, because the toolbar and the canvas both
// read it.

import { applyTheme, storedTheme, type ThemeId } from '$lib/theme';
import { isWebKitGTK } from '$lib/platform';

/** Widest a window is taken for a phone's: past it the four menus fit side
 *  by side with the search field, at it they do not. */
const NARROW_PX = 640;

/** Where the optional view switches are kept between sessions. */
const TINT_KEY = 'sanity.tintLanguages';
const LABELS_KEY = 'sanity.dirLabels';
const FOLLOW_KEY = 'sanity.historyFollow';
const EXPAND_KEY = 'sanity.expandDocuments';

function storedFlag(key: string, fallback = false): boolean {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === '1';
	} catch {
		return fallback;
	}
}

function storeFlag(key: string, on: boolean): void {
	try {
		localStorage.setItem(key, on ? '1' : '0');
	} catch {
		// A session without storage keeps the switch for as long as it runs.
	}
}

class UiState {
	theme = $state<ThemeId>(storedTheme());
	/** Which toolbar menu is open, if any. One at a time. */
	openMenu = $state<'project' | 'files' | 'view' | 'theme' | 'all' | null>(null);
	/**
	 * The window is a phone's width: the toolbar folds its four menus into
	 * one and the sheets span the screen. Followed from a media query rather
	 * than set in CSS, because a component's styles may only use the tokens
	 * and a media query cannot.
	 */
	narrow = $state(false);
	/**
	 * Colour the outermost zoom by language family.
	 *
	 * Off by default. At that distance a panel is a few pixels of texture, and
	 * a second colour scheme over the syntax colours competes with the thing
	 * the canvas is normally watched for, which is where something changed. On,
	 * it answers a different question: what a directory is made of.
	 */
	tintLanguages = $state(storedFlag(TINT_KEY));
	/**
	 * Name the directories in screen space, with a breadcrumb for the ones the
	 * view is inside of, instead of in their frames.
	 *
	 * Off by default. The names in the frames are part of the canvas and stay
	 * out of the way; these sit over the code, which is what naming a region
	 * at the outermost zoom takes, and not what everybody wants on screen.
	 */
	dirLabels = $state(storedFlag(LABELS_KEY));
	/**
	 * Stepping through the history flies to what each step changed.
	 *
	 * On by default, unlike the others: a commit is usually a handful of files
	 * somewhere in the project, and without this the step plays wherever the
	 * view happens to be, often entirely off screen.
	 */
	historyFollow = $state(storedFlag(FOLLOW_KEY, true));
	/**
	 * A document shows every page instead of its first.
	 *
	 * Off by default: at the zoom this app is watched at, a document's first
	 * page is what says which document it is, and the rest is reading.
	 */
	expandDocuments = $state(storedFlag(EXPAND_KEY));

	/**
	 * Draws the canvas in the colours the document has now, at once; set by
	 * the canvas when it exists. See `setTheme`.
	 */
	repaint: (() => void) | null = null;

	/**
	 * Switch themes as a crossfade of the whole window, canvas included.
	 *
	 * The browser keeps a picture of the window as it was, the theme changes
	 * underneath it, and the two are faded into each other. The canvas has to
	 * be drawn in the new colours inside that change, not on the next frame,
	 * or the picture taken of the new window still has the old canvas in it
	 * and the canvas cuts over a moment after everything else has faded.
	 * A cut where the browser has no transitions, or motion is reduced.
	 *
	 * A cut on Linux too. WebKitGTK composites a view transition even when it
	 * is running without accelerated compositing, as it does on NVIDIA where
	 * the DMA-BUF renderer is turned off (see `prefer_software_compositing` in
	 * src-tauri) and wherever GTK cannot get GL, and there it has nothing to
	 * composite into and the window crashes. The theme is already stored by
	 * then, so the next launch opens in the theme that crashed it.
	 */
	/** Follow the window's width for `narrow`. Called once, by the app. */
	watchWidth(): void {
		const q = matchMedia(`(max-width: ${NARROW_PX}px)`);
		const follow = () => {
			this.narrow = q.matches;
			// A menu of the other layout is not in this one to close.
			this.openMenu = null;
		};
		follow();
		q.addEventListener('change', follow);
	}

	setTheme(id: ThemeId) {
		const change = () => {
			this.theme = id;
			applyTheme(id);
			this.repaint?.();
		};
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (still || isWebKitGTK() || typeof document.startViewTransition !== 'function') {
			change();
			return;
		}
		document.startViewTransition(change);
	}

	setTintLanguages(on: boolean) {
		this.tintLanguages = on;
		try {
			localStorage.setItem(TINT_KEY, on ? '1' : '0');
		} catch {
			// A session without storage keeps the switch for as long as it runs.
		}
	}

	setDirLabels(on: boolean) {
		this.dirLabels = on;
		try {
			localStorage.setItem(LABELS_KEY, on ? '1' : '0');
		} catch {
			// As for the tint.
		}
	}

	setHistoryFollow(on: boolean) {
		this.historyFollow = on;
		storeFlag(FOLLOW_KEY, on);
	}

	setExpandDocuments(on: boolean) {
		this.expandDocuments = on;
		storeFlag(EXPAND_KEY, on);
	}

	apply() {
		applyTheme(this.theme);
	}
}

export const ui = new UiState();

// App chrome state: theme, which menu is open, and the view switches that are
// off by default. Small, but shared, because the toolbar and the canvas both
// read it.

import { applyTheme, storedTheme, type ThemeId } from '$lib/theme';

/** Where the optional view switches are kept between sessions. */
const TINT_KEY = 'sanity.tintLanguages';
const LABELS_KEY = 'sanity.dirLabels';

function storedFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === '1';
	} catch {
		return false;
	}
}

class UiState {
	theme = $state<ThemeId>(storedTheme());
	/** Which toolbar menu is open, if any. One at a time. */
	openMenu = $state<'project' | 'view' | 'theme' | null>(null);
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

	setTheme(id: ThemeId) {
		this.theme = id;
		applyTheme(id);
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

	apply() {
		applyTheme(this.theme);
	}
}

export const ui = new UiState();

// App chrome state: theme and which menu is open. Small, but shared, because
// the toolbar and the canvas both read it.

import { applyTheme, storedTheme, type ThemeId } from '$lib/theme';

class UiState {
	theme = $state<ThemeId>(storedTheme());
	/** Which toolbar menu is open, if any. One at a time. */
	openMenu = $state<'project' | 'view' | 'theme' | null>(null);

	setTheme(id: ThemeId) {
		this.theme = id;
		applyTheme(id);
	}

	apply() {
		applyTheme(this.theme);
	}
}

export const ui = new UiState();

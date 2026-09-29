import { invoke } from '@tauri-apps/api/core';
import type { Theme } from '../types';
import { colorScheme, DEFAULT_COLOR_SCHEME, parseColorScheme } from '../theme/schemes';

// Mirrors the key the bootstrap script in app.html reads.
const THEME_KEY = 'oyot:theme';

export async function initializeTheme(): Promise<Theme> {
    let stored: Theme | null = null;
    try {
        // Null when nothing has been chosen. That device gets the default
        // scheme rather than one picked from its light or dark setting: the
        // default is a choice the app makes, not a guess (ADR 0036).
        stored = parseColorScheme(await invoke<string | null>('get_theme'));
    } catch (error) {
        console.error('Failed to load the colour scheme:', error);
    }

    const theme = stored ?? DEFAULT_COLOR_SCHEME;
    applyTheme(theme);
    return theme;
}

export async function saveTheme(theme: Theme): Promise<void> {
    try {
        await invoke('save_theme', { theme });
    } catch (error) {
        console.error('Failed to save the colour scheme:', error);
        throw error;
    }
}

export function applyTheme(theme: Theme): void {
    // On the root element, not the body, so the bootstrap script can set it
    // before the body exists. data-scheme picks the colours; data-theme says
    // whether they are light or dark, for the few rules that differ by that
    // alone, such as how deep a shadow has to be to show.
    const root = document.documentElement;
    root.dataset.scheme = theme;
    root.dataset.theme = colorScheme(theme).appearance;
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        // Private browsing or a locked-down webview. The scheme still applies
        // for this session; only the flash-free start is lost.
    }
}

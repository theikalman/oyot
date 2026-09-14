import { invoke } from '@tauri-apps/api/core';
import type { Theme } from '../types';

// Mirrors the key the bootstrap script in app.html reads.
const THEME_KEY = 'oyot:theme';

/** What the device asks for when the user has never chosen. */
export function systemTheme(): Theme {
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

export async function initializeTheme(): Promise<Theme> {
    let stored: Theme | null = null;
    try {
        // Null when nothing has been chosen, which is why this is not just a
        // string: defaulting to light in Rust made "never chosen" and "chose
        // light" indistinguishable, so the device preference could never win.
        const value = await invoke<string | null>('get_theme');
        if (value === 'light' || value === 'dark') stored = value;
    } catch (error) {
        console.error('Failed to load theme:', error);
    }

    const theme = stored ?? systemTheme();
    applyTheme(theme);
    return theme;
}

export async function saveTheme(theme: Theme): Promise<void> {
    try {
        await invoke('save_theme', { theme });
    } catch (error) {
        console.error('Failed to save theme:', error);
        throw error;
    }
}

export function applyTheme(theme: Theme): void {
    // On the root element, not the body, so the bootstrap script can set it
    // before the body exists.
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        // Private browsing or a locked-down webview. The theme still applies
        // for this session; only the flash-free start is lost.
    }
}

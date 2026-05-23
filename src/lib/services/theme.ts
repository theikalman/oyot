import { invoke } from '@tauri-apps/api/core';
import type { Theme } from '../types';

export async function initializeTheme(): Promise<Theme> {
    try {
        const theme: Theme = await invoke('get_theme');
        applyTheme(theme);
        return theme;
    } catch (error) {
        console.error('Failed to load theme:', error);
        applyTheme('light');
        return 'light';
    }
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
    document.body.dataset.theme = theme;
}
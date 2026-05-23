<script lang="ts">
    import { goto } from '$app/navigation';
    import { appStore, theme, syncStore } from '$lib/stores/app';
    import type { Theme } from '$lib/types';
    import { invoke } from '@tauri-apps/api/core';

    let currentTheme = $derived($theme);
    let currentDocId = $derived($appStore.currentDocument?.id);
    let syncStatus = $derived($syncStore);
    let isSyncEnabled = $derived(syncStatus.isEnabled);

    async function handleThemeToggle() {
        const next: Theme = currentTheme === 'light' ? 'dark' : 'light';
        appStore.setTheme(next);
        try {
            await invoke('save_theme', { theme: next });
        } catch (error) {
            console.error('Failed to save theme:', error);
        }
    }

    function goToSyncSettings() {
        goto('/settings/sync');
    }
</script>

<div class="settings-page">
    <section class="settings-section">
        <h2 class="section-title">Appearance</h2>
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Theme</span>
                    <span class="setting-desc">Switch between light and dark mode</span>
                </div>
                <button
                    class="theme-toggle-btn"
                    onclick={handleThemeToggle}
                    title={currentTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
                >
                    {currentTheme === 'light' ? '☾' : '☀'}
                </button>
            </div>
        </div>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Sync</h2>
        <button class="section-card settings-link" onclick={goToSyncSettings}>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Sync Settings</span>
                    <span class="setting-desc">
                        {isSyncEnabled ? 'Enabled' : 'Disabled'} • Manage paired devices and sync options
                    </span>
                </div>
                <svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 18l6-6-6-6"/>
                </svg>
            </div>
        </button>
    </section>
</div>

<style>
    .settings-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }

    .settings-section {
        margin-bottom: 32px;
    }

    .section-title {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .section-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        overflow: hidden;
    }

    .setting-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
    }

    .setting-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .setting-label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 15px;
    }

    .setting-desc {
        font-size: 13px;
        color: var(--text-muted);
    }

    .theme-toggle-btn {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        font-size: 20px;
        cursor: pointer;
        color: var(--text-primary);
        transition: background-color 0.15s;
    }

    .theme-toggle-btn:hover {
        background: var(--bg-hover);
    }

    .settings-link {
        background: transparent;
        border: 1px solid var(--border-color);
        border-radius: 12px;
        cursor: pointer;
        width: 100%;
        text-align: left;
        padding: 0;
    }

    .settings-link:hover {
        background: var(--bg-hover);
    }

    .chevron {
        color: var(--text-muted);
        flex-shrink: 0;
    }
</style>
// Keeping Oyot running on a desktop when its window is closed (ADR 0030).
//
// Rust owns the window, the tray and the login item; the page reads and
// changes the two settings, and takes part in closing (see closeFlow.ts).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { flushPendingSaves } from '$lib/editor/pendingSaves';
import { createCloseFlow, type CloseAction } from './closeFlow';

export interface DesktopSettings {
    /** False on a phone, which has no window to close and no login to start at. */
    supported: boolean;
    keepRunning: boolean;
    startAtLogin: boolean;
    closeNoticeSeen: boolean;
}

export function getDesktopSettings(): Promise<DesktopSettings> {
    return invoke<DesktopSettings>('get_desktop_settings');
}

export function setKeepRunning(keepRunning: boolean): Promise<void> {
    return invoke<void>('set_keep_running', { keepRunning });
}

/** Resolves to what the OS now has registered, which is what to show. */
export function setStartAtLogin(start: boolean): Promise<boolean> {
    return invoke<boolean>('set_start_at_login', { start });
}

/**
 * Where a hidden Oyot is found, in the words each desktop uses for it.
 *
 * Falls back to the generic name when the platform cannot be told, which is
 * outside Tauri (tests, the browser preview).
 */
export async function trayPlace(): Promise<string> {
    try {
        const { platform } = await import('@tauri-apps/plugin-os');
        return platform() === 'macos' ? 'the menu bar' : 'the system tray';
    } catch {
        return 'the system tray';
    }
}

/**
 * Take part in closing the window: answer Rust, save, show the first-close
 * notice when it is due, and tell Rust how to finish.
 *
 * `askKeepRunning` shows the notice and resolves true for "Keep running".
 * Returns the function that stops listening.
 */
export function watchCloseRequests(askKeepRunning: () => Promise<boolean>): () => void {
    const handle = createCloseFlow({
        acknowledge: (id) => invoke<void>('close_acknowledged', { id }),
        flushPendingSaves,
        settings: getDesktopSettings,
        askKeepRunning,
        answerNotice: (keepRunning) => invoke<void>('answer_close_notice', { keepRunning }),
        finish: (action: CloseAction) => invoke<void>('finish_close', { action }),
    });

    let stopped = false;
    let unlisten: (() => void) | null = null;
    listen<number>('main-window-close-requested', (event) => void handle(event.payload))
        .then((un) => {
            if (stopped) un();
            else unlisten = un;
        })
        .catch((e) => console.warn('[close] cannot listen for close requests:', e));

    return () => {
        stopped = true;
        unlisten?.();
    };
}

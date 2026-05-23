import { writable } from 'svelte/store';

export interface Toast {
    id: string;
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
    duration: number;
}

const MAX_TOASTS = 5;
const DEFAULT_DURATIONS = {
    success: 3000,
    error: 5000,
    info: 3000,
    warning: 4000
};

function createToastStore() {
    const { subscribe, update } = writable<Toast[]>([]);

    function removeToast(id: string) {
        update(toasts => toasts.filter(t => t.id !== id));
    }

    function addToast(type: Toast['type'], message: string, duration?: number): string {
        const id = crypto.randomUUID();
        const finalDuration = duration ?? DEFAULT_DURATIONS[type];

        update(toasts => {
            const newToast: Toast = { id, type, message, duration: finalDuration };
            const updated = [newToast, ...toasts].slice(0, MAX_TOASTS);
            return updated;
        });

        if (finalDuration > 0) {
            setTimeout(() => removeToast(id), finalDuration);
        }

        return id;
    }

    return {
        subscribe,
        success: (message: string, duration?: number) => addToast('success', message, duration),
        error: (message: string, duration?: number) => addToast('error', message, duration),
        info: (message: string, duration?: number) => addToast('info', message, duration),
        warning: (message: string, duration?: number) => addToast('warning', message, duration),
        remove: removeToast,
        clear: () => update(() => [])
    };
}

export const toasts = createToastStore();
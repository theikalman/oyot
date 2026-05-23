let loroModule: typeof import('loro-prosemirror') | null = null;
let loroCrdtModule: typeof import('loro-crdt') | null = null;
let isLoading = false;
let loadPromise: Promise<void> | null = null;

export async function loadLoroModules(): Promise<typeof import('loro-prosemirror')> {
    if (loroModule) {
        return loroModule;
    }

    if (loadPromise) {
        await loadPromise;
        return loroModule!;
    }

    isLoading = true;

    loadPromise = (async () => {
        try {
            loroCrdtModule = await import('loro-crdt');

            loroModule = await import('loro-prosemirror');
        } catch (error) {
            console.error('[loroLazy] Failed to load loro modules:', error);
            throw error;
        } finally {
            isLoading = false;
        }
    })();

    await loadPromise;
    return loroModule!;
}

export function getLoroModule(): typeof import('loro-prosemirror') | null {
    return loroModule;
}

export function getLoroCrdtModule(): typeof import('loro-crdt') | null {
    return loroCrdtModule;
}

export function isLoroLoaded(): boolean {
    return loroModule !== null;
}

export function isLoroLoading(): boolean {
    return isLoading;
}

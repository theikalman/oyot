// Stand-ins for the SvelteKit ambient modules, for the standalone vitest
// config.
//
// `vitest.config.ts` does not load the SvelteKit plugin (see the note there),
// so `$app/*` does not resolve. That only became a problem when code reachable
// from a unit test started navigating: the document link node opens its target
// through `$app/navigation`, and the tests that walk a document for its index
// import it transitively.
//
// Navigation is not what those tests are about, so the stub only has to exist
// and be inert.

export function goto(_url: string): Promise<void> {
    return Promise.resolve();
}

export function resolve(route: string, params: Record<string, string> = {}): string {
    return route.replace(/\[([^\]]+)\]/g, (_, name: string) =>
        encodeURIComponent(params[name] ?? ''),
    );
}

export const base = '';
export const assets = '';

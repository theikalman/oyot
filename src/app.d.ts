// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
    namespace App {
        /**
         * What a shallow-routed step in the history shows over the page it
         * was taken from (`pushState` in `$app/navigation`). Not in the URL,
         * so a reload shows the page alone.
         */
        interface PageState {
            /** An email opened from a note's chip. */
            email?: { hash: string; subject: string | null };
        }
    }
}

export {};

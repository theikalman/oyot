import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(resolve(__dirname, './package.json'), 'utf8'));

// Standalone from vite.config.js (which is async and pulls in the SvelteKit
// plugin). Unit tests here cover the framework-free sync core.
export default defineConfig({
    // Mirrors the `define` in vite.config.js so src/lib/version.ts resolves.
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
        alias: {
            $lib: resolve(__dirname, './src/lib'),
            // Without the SvelteKit plugin these do not resolve, and anything
            // that navigates is reachable from a unit test by import.
            '$app/navigation': resolve(__dirname, './src/test/sveltekit-stubs.ts'),
            '$app/paths': resolve(__dirname, './src/test/sveltekit-stubs.ts'),
        },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.{test,spec}.ts'],
    },
});

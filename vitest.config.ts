import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Standalone from vite.config.js (which is async and pulls in the SvelteKit
// plugin). Unit tests here cover the framework-free sync core.
export default defineConfig({
    resolve: {
        alias: {
            $lib: resolve(__dirname, './src/lib'),
        },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.{test,spec}.ts'],
    },
});

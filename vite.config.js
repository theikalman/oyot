import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

const host = process.env.TAURI_DEV_HOST;

// The app shows its own version (see src/lib/version.ts), so bake it in here
// rather than importing package.json into the bundle.
const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
);

// https://vite.dev/config/
export default defineConfig(async () => ({
    // No WebAssembly or top-level-await plugins. They came in for Loro, long
    // gone, and the top-level-await one wraps every chunk in an async
    // function, which turns function declarations into assignments: code
    // that called one before its line, as Mermaid's d3 does, got undefined
    // in the release build and worked in dev, which does not bundle.
    plugins: [sveltekit()],

    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                  protocol: 'ws',
                  host,
                  port: 1421,
              }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ['**/src-tauri/**'],
        },
    },
}));

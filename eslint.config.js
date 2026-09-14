import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
    js.configs.recommended,
    ...ts.configs.recommended,
    ...svelte.configs['flat/recommended'],
    {
        languageOptions: {
            globals: { ...globals.browser, ...globals.es2021 },
        },
        rules: {
            // The sync layer deliberately parses `unknown` off the wire and narrows
            // with type guards; `any` in the Tiptap node-view signatures mirrors the
            // library's own typing. Warn so new ones are visible, do not block.
            '@typescript-eslint/no-explicit-any': 'warn',
            // `console.log` is tracing, and tracing must not ship: `log.debug`
            // folds away in a production build. `warn` and `error` are kept,
            // because a user reporting a problem should have something to
            // read, which is exactly what `log.warn`/`log.error` forward to.
            'no-console': ['error', { allow: ['warn', 'error'] }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    {
        files: ['**/*.svelte'],
        languageOptions: {
            parserOptions: { parser: ts.parser },
        },
    },
    {
        // Build configuration runs in Node, not the browser.
        files: ['*.config.js', '*.config.ts', 'svelte.config.js'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        ignores: [
            'build/',
            'dist/',
            '.svelte-kit/',
            'node_modules/',
            'src-tauri/target/',
            'src-tauri/gen/',
        ],
    },
);

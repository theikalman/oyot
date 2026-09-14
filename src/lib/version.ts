// The running app version. Injected at build time from the `version` field in
// package.json (see the `define` block in vite.config.js), so there is nothing
// to fetch and nothing to keep in sync at runtime.
//
// package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the newest
// entry in changelog.ts all have to carry the same version; version.test.ts
// fails the build when one of them is left behind.
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;

// Logging that does not ship.
//
// The sync and editor paths trace heavily, which is what makes a pairing or a
// merge problem diagnosable at all. None of it belongs in a release build: it
// is noise, it costs string formatting on the hot save path, and the signaling
// traces name device ids on every message.
//
// `debug` compiles down to a no-op call in production. `warn` and `error` stay,
// because a user reporting a problem should have something to read.

// `import.meta.env.DEV` is a Vite build-time constant, so the branch folds away
// at build time. It is absent under vitest, where tracing is unwanted anyway.
const DEV = typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;

type Args = unknown[];

export const log = {
    /** Tracing. Dev builds only. */
    debug: DEV ? (...args: Args) => console.log(...args) : () => {},
    /** Something unexpected that the app recovered from. Always emitted. */
    warn: (...args: Args) => console.warn(...args),
    /** Something failed. Always emitted. */
    error: (...args: Args) => console.error(...args),
};

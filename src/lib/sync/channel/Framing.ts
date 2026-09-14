import { base64ToBytes, bytesToBase64 } from '../protocol';

// A single Yjs document with an embedded base64 image easily exceeds the safe
// per-message size for an RTCDataChannel. This layer splits every outgoing
// message into portable chunks, reassembles them on the far side, and applies
// backpressure so a large transfer does not blow the send buffer.

const MAX_CHUNK = 16 * 1024; // portable SCTP payload
const BUFFER_HIGH = 1 * 1024 * 1024; // pause sending above this many buffered bytes
const BUFFER_LOW = 256 * 1024;

// Ceiling on a single reassembled message: 4096 * 16KB = 64MB. A begin frame
// claiming more than this is rejected rather than allocated, so a malformed or
// hostile peer cannot size our array for us.
export const MAX_CHUNKS = 4096;

// A partial message whose remaining chunks never arrive is dropped after this
// long. Without it an aborted transfer pins its chunks until the page reloads.
export const REASSEMBLY_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 15_000;

// A drain wait that never resolves would strand the send loop forever. The
// channel closing releases it; this is the backstop for a channel that is
// wedged without ever reporting closed. Hitting it abandons the whole message,
// not just the current chunk: a peer that cannot drain 1MB in 30s will not
// drain the next chunk either, and the reconnect path re-sends from scratch.
export const DRAIN_TIMEOUT_MS = 30_000;

type Frame =
    | { k: 0; d: unknown } // whole message
    | { k: 1; id: number; n: number } // begin: n chunks follow
    | { k: 2; id: number; i: number; p: string }; // chunk i, base64 payload

interface Partial {
    parts: string[];
    got: number;
    n: number;
    startedAt: number;
}

export interface FramedChannel {
    send(msg: unknown): Promise<void>;
    detach(): void;
    // Partial messages currently held for reassembly. Exposed for tests.
    pendingCount(): number;
}

export function attachFraming(
    channel: RTCDataChannel,
    onMessage: (msg: unknown) => void,
    now: () => number = Date.now,
): FramedChannel {
    channel.bufferedAmountLowThreshold = BUFFER_LOW;

    const inbox = new Map<number, Partial>();
    let seq = 0;

    function handle(raw: string): void {
        let frame: Frame;
        try {
            frame = JSON.parse(raw) as Frame;
        } catch {
            console.warn('[sync/framing] dropping unparseable frame');
            return;
        }
        if (frame.k === 0) {
            onMessage(frame.d);
            return;
        }
        if (frame.k === 1) {
            if (!Number.isInteger(frame.n) || frame.n <= 0 || frame.n > MAX_CHUNKS) {
                console.warn(`[sync/framing] rejecting begin frame with n=${frame.n}`);
                return;
            }
            inbox.set(frame.id, {
                parts: new Array(frame.n),
                got: 0,
                n: frame.n,
                startedAt: now(),
            });
            return;
        }
        // k === 2
        const entry = inbox.get(frame.id);
        if (!entry) return;
        if (!Number.isInteger(frame.i) || frame.i < 0 || frame.i >= entry.n) {
            console.warn(`[sync/framing] dropping chunk ${frame.i} outside 0..${entry.n - 1}`);
            return;
        }
        if (typeof frame.p !== 'string') return;
        if (entry.parts[frame.i] === undefined) entry.got++;
        entry.parts[frame.i] = frame.p;
        if (entry.got === entry.n) {
            inbox.delete(frame.id);
            try {
                const bytes = base64ToBytes(entry.parts.join(''));
                onMessage(JSON.parse(new TextDecoder().decode(bytes)));
            } catch (e) {
                console.warn('[sync/framing] failed to reassemble message:', e);
            }
        }
    }

    function sweep(): void {
        const cutoff = now() - REASSEMBLY_TIMEOUT_MS;
        for (const [id, entry] of inbox) {
            if (entry.startedAt <= cutoff) {
                console.warn(
                    `[sync/framing] discarding stalled message ${id} (${entry.got}/${entry.n} chunks)`,
                );
                inbox.delete(id);
            }
        }
    }

    const listener = (ev: MessageEvent) => handle(ev.data as string);
    channel.addEventListener('message', listener);
    const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);

    // Resolves true when the buffer drained, false when the wait was abandoned
    // (channel closed, errored, or wedged past DRAIN_TIMEOUT_MS).
    function waitForDrain(): Promise<boolean> {
        if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve(true);
        return new Promise((resolve) => {
            // `bufferedamountlow` never fires on a channel that closed mid
            // transfer, which left the send loop's promise permanently
            // unsettled and the caller's await hanging for the life of the tab.
            const settle = (drained: boolean) => {
                clearTimeout(timer);
                channel.removeEventListener('bufferedamountlow', onLow);
                channel.removeEventListener('close', onDead);
                channel.removeEventListener('error', onDead);
                resolve(drained);
            };
            const onLow = () => settle(true);
            const onDead = () => settle(false);
            const timer = setTimeout(() => {
                console.warn('[sync/framing] send buffer did not drain, abandoning message');
                settle(false);
            }, DRAIN_TIMEOUT_MS);
            channel.addEventListener('bufferedamountlow', onLow);
            channel.addEventListener('close', onDead);
            channel.addEventListener('error', onDead);
        });
    }

    async function send(msg: unknown): Promise<void> {
        if (channel.readyState !== 'open') return;
        const json = JSON.stringify(msg);
        const bytes = new TextEncoder().encode(json);

        if (bytes.length <= MAX_CHUNK) {
            channel.send(JSON.stringify({ k: 0, d: msg } satisfies Frame));
            return;
        }

        const id = seq++;
        const b64 = bytesToBase64(bytes);
        const chunks: string[] = [];
        for (let i = 0; i < b64.length; i += MAX_CHUNK) chunks.push(b64.slice(i, i + MAX_CHUNK));

        if (chunks.length > MAX_CHUNKS) {
            // Refuse rather than send a message the far side is required to
            // reject, which would strand it mid-reassembly until the sweep.
            console.error(
                `[sync/framing] message of ${bytes.length} bytes needs ${chunks.length} chunks, over the ${MAX_CHUNKS} limit`,
            );
            return;
        }

        channel.send(JSON.stringify({ k: 1, id, n: chunks.length } satisfies Frame));
        for (let i = 0; i < chunks.length; i++) {
            if (!(await waitForDrain())) return;
            if (channel.readyState !== 'open') return;
            channel.send(JSON.stringify({ k: 2, id, i, p: chunks[i] } satisfies Frame));
        }
    }

    return {
        send,
        detach: () => {
            channel.removeEventListener('message', listener);
            clearInterval(sweepTimer);
            inbox.clear();
        },
        pendingCount: () => inbox.size,
    };
}

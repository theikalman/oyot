import { createWriteQueue } from '../writeQueue';

// A single message can easily exceed the safe per-message size for an
// RTCDataChannel: a document with several images attached, or an attachment
// transfer. This layer splits every outgoing message into portable chunks,
// reassembles them on the far side, and applies backpressure so a large
// transfer does not blow the send buffer.
//
// Chunks travel as binary frames. They used to be base64 inside JSON, which
// cost 1.33x on the wire plus the JSON wrapper, on top of the base64 the
// attachment payload already carries from Rust. The control frames stay JSON,
// because they are small and easier to read in a log.

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
    | { k: 1; id: number; n: number }; // begin: n binary chunks follow

// Each chunk is a binary frame: a uint32 message id, a uint32 index, then the
// payload. Fixed width so the header can be read without parsing anything.
const CHUNK_HEADER_BYTES = 8;

interface Partial {
    parts: Array<Uint8Array | undefined>;
    got: number;
    n: number;
    startedAt: number;
}

export interface FramedChannel {
    /** Resolves true when the message reached the channel, false when it did not. */
    send(msg: unknown): Promise<boolean>;
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
    // Without this a binary frame arrives as a Blob, which can only be read
    // asynchronously and would reorder chunk handling.
    channel.binaryType = 'arraybuffer';

    const inbox = new Map<number, Partial>();
    let seq = 0;
    // One message at a time per channel. A short message used to be sent
    // immediately while a chunked one was parked waiting for the buffer to
    // drain, so a `doc-deleted` could overtake the `sync-delta` for the same
    // document.
    const sendQueue = createWriteQueue();

    function finish(id: number, entry: Partial): void {
        inbox.delete(id);
        try {
            let total = 0;
            for (const part of entry.parts) total += part?.length ?? 0;
            const joined = new Uint8Array(total);
            let at = 0;
            for (const part of entry.parts) {
                if (part) {
                    joined.set(part, at);
                    at += part.length;
                }
            }
            onMessage(JSON.parse(new TextDecoder().decode(joined)));
        } catch (e) {
            console.warn('[sync/framing] failed to reassemble message:', e);
        }
    }

    function handleChunk(buffer: ArrayBuffer): void {
        if (buffer.byteLength < CHUNK_HEADER_BYTES) {
            console.warn('[sync/framing] dropping undersized binary frame');
            return;
        }
        const view = new DataView(buffer);
        const id = view.getUint32(0);
        const index = view.getUint32(4);

        const entry = inbox.get(id);
        if (!entry) return;
        if (index >= entry.n) {
            console.warn(`[sync/framing] dropping chunk ${index} outside 0..${entry.n - 1}`);
            return;
        }
        if (entry.parts[index] === undefined) entry.got++;
        entry.parts[index] = new Uint8Array(buffer, CHUNK_HEADER_BYTES);
        if (entry.got === entry.n) finish(id, entry);
    }

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
        console.warn('[sync/framing] dropping unknown frame kind');
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

    const listener = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') handle(ev.data);
        else if (ev.data instanceof ArrayBuffer) handleChunk(ev.data);
        else console.warn('[sync/framing] dropping frame of unexpected type');
    };
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

    // Resolves true when the whole message reached the channel, false when it
    // did not. A caller that gets false knows the peer will never see it,
    // which is what tells an unanswered request from an unsent one.
    async function sendNow(msg: unknown): Promise<boolean> {
        if (channel.readyState !== 'open') return false;
        const bytes = new TextEncoder().encode(JSON.stringify(msg));

        if (bytes.length <= MAX_CHUNK) {
            channel.send(JSON.stringify({ k: 0, d: msg } satisfies Frame));
            return true;
        }

        const chunkCount = Math.ceil(bytes.length / MAX_CHUNK);
        if (chunkCount > MAX_CHUNKS) {
            // Refuse rather than send a message the far side is required to
            // reject, which would strand it mid-reassembly until the sweep.
            console.error(
                `[sync/framing] message of ${bytes.length} bytes needs ${chunkCount} chunks, over the ${MAX_CHUNKS} limit`,
            );
            return false;
        }

        const id = seq++;
        channel.send(JSON.stringify({ k: 1, id, n: chunkCount } satisfies Frame));
        for (let i = 0; i < chunkCount; i++) {
            if (!(await waitForDrain())) return false;
            if (channel.readyState !== 'open') return false;

            const slice = bytes.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK);
            const frame = new Uint8Array(CHUNK_HEADER_BYTES + slice.length);
            const view = new DataView(frame.buffer);
            view.setUint32(0, id);
            view.setUint32(4, i);
            frame.set(slice, CHUNK_HEADER_BYTES);
            channel.send(frame.buffer);
        }
        return true;
    }

    // Queued, so two messages never interleave on the wire: the second used to
    // go out while the first was parked waiting for the send buffer to drain.
    function send(msg: unknown): Promise<boolean> {
        return sendQueue('channel', () => sendNow(msg));
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

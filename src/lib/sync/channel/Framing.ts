import { base64ToBytes, bytesToBase64 } from '../protocol';

// A single Yjs document with an embedded base64 image easily exceeds the safe
// per-message size for an RTCDataChannel. This layer splits every outgoing
// message into portable chunks, reassembles them on the far side, and applies
// backpressure so a large transfer does not blow the send buffer.

const MAX_CHUNK = 16 * 1024; // portable SCTP payload
const BUFFER_HIGH = 1 * 1024 * 1024; // pause sending above this many buffered bytes
const BUFFER_LOW = 256 * 1024;

type Frame =
    | { k: 0; d: unknown } // whole message
    | { k: 1; id: number; n: number } // begin: n chunks follow
    | { k: 2; id: number; i: number; p: string }; // chunk i, base64 payload

export interface FramedChannel {
    send(msg: unknown): Promise<void>;
    detach(): void;
}

export function attachFraming(
    channel: RTCDataChannel,
    onMessage: (msg: unknown) => void,
): FramedChannel {
    channel.bufferedAmountLowThreshold = BUFFER_LOW;

    const inbox = new Map<number, { parts: string[]; got: number; n: number }>();
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
            inbox.set(frame.id, { parts: new Array(frame.n), got: 0, n: frame.n });
            return;
        }
        // k === 2
        const entry = inbox.get(frame.id);
        if (!entry) return;
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

    const listener = (ev: MessageEvent) => handle(ev.data as string);
    channel.addEventListener('message', listener);

    function waitForDrain(): Promise<void> {
        if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
        return new Promise((resolve) => {
            const onLow = () => {
                channel.removeEventListener('bufferedamountlow', onLow);
                resolve();
            };
            channel.addEventListener('bufferedamountlow', onLow);
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

        channel.send(JSON.stringify({ k: 1, id, n: chunks.length } satisfies Frame));
        for (let i = 0; i < chunks.length; i++) {
            await waitForDrain();
            if (channel.readyState !== 'open') return;
            channel.send(JSON.stringify({ k: 2, id, i, p: chunks[i] } satisfies Frame));
        }
    }

    return {
        send,
        detach: () => channel.removeEventListener('message', listener),
    };
}

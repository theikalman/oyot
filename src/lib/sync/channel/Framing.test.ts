import { describe, it, expect, vi } from 'vitest';
import { attachFraming, MAX_CHUNKS, REASSEMBLY_TIMEOUT_MS, DRAIN_TIMEOUT_MS } from './Framing';

// Minimal RTCDataChannel stand-in: an EventTarget with send()/readyState that
// forwards each sent string to its wired partner as a 'message' event.
class FakeChannel extends EventTarget {
    readyState: RTCDataChannelState = 'open';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: 'arraybuffer' | 'blob' = 'blob';
    partner: FakeChannel | null = null;
    // Everything put on the wire, so a test can assert how it was framed and
    // not merely that it arrived.
    sent: Array<string | ArrayBuffer> = [];

    send(data: string | ArrayBuffer): void {
        this.sent.push(data);
        queueMicrotask(() => {
            this.partner?.dispatchEvent(Object.assign(new Event('message'), { data }));
        });
    }
}

function pair(): [FakeChannel, FakeChannel] {
    const a = new FakeChannel();
    const b = new FakeChannel();
    a.partner = b;
    b.partner = a;
    return [a, b];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Framing', () => {
    it('sends chunk payloads as binary, not base64 inside JSON', async () => {
        // Base64 in JSON cost 1.33x plus the wrapper, on top of the base64 an
        // attachment payload already carries from Rust.
        const [a, b] = pair();
        attachFraming(b as unknown as RTCDataChannel, () => {});
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        await sender.send({ body: 'x'.repeat(200 * 1024) });

        const binary = a.sent.filter((f) => f instanceof ArrayBuffer);
        expect(binary.length).toBeGreaterThan(0);
        // One JSON control frame announcing the chunks, and nothing else.
        expect(a.sent.filter((f) => typeof f === 'string')).toHaveLength(1);
        expect(a.binaryType).toBe('arraybuffer');
    });

    it('does not let a short message overtake a chunked one', async () => {
        // A `doc-deleted` arriving before the `sync-delta` for the same
        // document applies the delete and then writes content back under it.
        const [a, b] = pair();
        const order: string[] = [];
        attachFraming(b as unknown as RTCDataChannel, (m) => order.push((m as { id: string }).id));
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        const big = sender.send({ id: 'big', body: 'A'.repeat(300 * 1024) });
        const small = sender.send({ id: 'small' });
        await Promise.all([big, small]);
        await flush();

        expect(order).toEqual(['big', 'small']);
    });

    it('reports a send the channel never took', async () => {
        const [a, b] = pair();
        attachFraming(b as unknown as RTCDataChannel, () => {});
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        a.readyState = 'closed';

        expect(await sender.send({ id: 'lost' })).toBe(false);
    });

    it('reports a successful send', async () => {
        const [a, b] = pair();
        attachFraming(b as unknown as RTCDataChannel, () => {});
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        expect(await sender.send({ id: 'fine' })).toBe(true);
        expect(await sender.send({ body: 'x'.repeat(100 * 1024) })).toBe(true);
    });

    it('round-trips messages of assorted sizes intact', async () => {
        const [a, b] = pair();
        const received: unknown[] = [];
        attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m));
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        const sizes = [0, 1, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 200 * 1024];
        for (const n of sizes) {
            await sender.send({ tag: n, body: 'x'.repeat(n) });
        }
        await flush();

        expect(received.map((m) => (m as { tag: number }).tag)).toEqual(sizes);
        for (const m of received) {
            const msg = m as { tag: number; body: string };
            expect(msg.body.length).toBe(msg.tag);
        }
    });

    it('interleaved large messages on one channel reassemble independently', async () => {
        const [a, b] = pair();
        const received: Array<{ id: string; body: string }> = [];
        attachFraming(b as unknown as RTCDataChannel, (m) =>
            received.push(m as { id: string; body: string }),
        );
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        await Promise.all([
            sender.send({ id: 'one', body: 'A'.repeat(80 * 1024) }),
            sender.send({ id: 'two', body: 'B'.repeat(80 * 1024) }),
        ]);
        await flush();

        const byId = Object.fromEntries(received.map((m) => [m.id, m.body]));
        expect(byId.one).toBe('A'.repeat(80 * 1024));
        expect(byId.two).toBe('B'.repeat(80 * 1024));
    });

    it('stops sending once the channel closes', async () => {
        const [a, b] = pair();
        const received: unknown[] = [];
        attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m));
        const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

        a.readyState = 'closed';
        await sender.send({ hello: 'world' });
        await flush();
        expect(received).toHaveLength(0);
    });

    // --- malformed input ---------------------------------------------------

    it('rejects a begin frame claiming more chunks than the limit', async () => {
        const [a, b] = pair();
        const framed = attachFraming(b as unknown as RTCDataChannel, () => {});

        for (const n of [MAX_CHUNKS + 1, 2 ** 31, -1, 0, 1.5, 'lots']) {
            a.send(JSON.stringify({ k: 1, id: 1, n }));
        }
        await flush();

        expect(framed.pendingCount()).toBe(0);
        framed.detach();
    });

    it('ignores a chunk index outside the declared range', async () => {
        const [a, b] = pair();
        const received: unknown[] = [];
        const framed = attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m));

        a.send(JSON.stringify({ k: 1, id: 7, n: 2 }));
        await flush();
        for (const i of [-1, 2, 99, 1.5]) {
            a.send(JSON.stringify({ k: 2, id: 7, i, p: 'AAAA' }));
        }
        await flush();

        // Still waiting on both real chunks, and nothing was delivered.
        expect(framed.pendingCount()).toBe(1);
        expect(received).toHaveLength(0);
        framed.detach();
    });

    it('a duplicate chunk does not complete the message early', async () => {
        const [a, b] = pair();
        const received: unknown[] = [];
        const framed = attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m));

        a.send(JSON.stringify({ k: 1, id: 3, n: 2 }));
        await flush();
        a.send(JSON.stringify({ k: 2, id: 3, i: 0, p: 'AAAA' }));
        a.send(JSON.stringify({ k: 2, id: 3, i: 0, p: 'AAAA' }));
        await flush();

        expect(received).toHaveLength(0);
        expect(framed.pendingCount()).toBe(1);
        framed.detach();
    });

    // --- reclaiming partial messages ---------------------------------------

    it('discards a partial message whose chunks never arrive', async () => {
        vi.useFakeTimers();
        try {
            const [a, b] = pair();
            let clock = 0;
            const framed = attachFraming(
                b as unknown as RTCDataChannel,
                () => {},
                () => clock,
            );

            a.send(JSON.stringify({ k: 1, id: 1, n: 4 }));
            await vi.advanceTimersByTimeAsync(0);
            a.send(JSON.stringify({ k: 2, id: 1, i: 0, p: 'AAAA' }));
            await vi.advanceTimersByTimeAsync(0);
            expect(framed.pendingCount()).toBe(1);

            // Sender goes away. The sweep must reclaim the buffered chunk.
            clock = REASSEMBLY_TIMEOUT_MS + 1;
            await vi.advanceTimersByTimeAsync(REASSEMBLY_TIMEOUT_MS + 1);

            expect(framed.pendingCount()).toBe(0);
            framed.detach();
        } finally {
            vi.useRealTimers();
        }
    });

    it('detach drops buffered partials and stops listening', async () => {
        const [a, b] = pair();
        const received: unknown[] = [];
        const framed = attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m));

        a.send(JSON.stringify({ k: 1, id: 1, n: 2 }));
        await flush();
        a.send(JSON.stringify({ k: 2, id: 1, i: 0, p: 'AAAA' }));
        await flush();
        expect(framed.pendingCount()).toBe(1);

        framed.detach();
        expect(framed.pendingCount()).toBe(0);

        a.send(JSON.stringify({ k: 0, d: { after: 'detach' } }));
        await flush();
        expect(received).toHaveLength(0);
    });

    // --- backpressure ------------------------------------------------------

    it('a send blocked on drain resolves when the channel closes', async () => {
        vi.useFakeTimers();
        try {
            const [a, b] = pair();
            attachFraming(b as unknown as RTCDataChannel, () => {});
            const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

            // Over BUFFER_HIGH, so the send loop parks on waitForDrain.
            a.bufferedAmount = 8 * 1024 * 1024;

            let settled = false;
            const pending = sender.send({ body: 'x'.repeat(200 * 1024) }).then(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(10);
            expect(settled).toBe(false);

            // The channel dies mid-transfer. 'bufferedamountlow' will never
            // fire, so only the close listener can release the wait.
            a.readyState = 'closed';
            a.dispatchEvent(new Event('close'));
            await vi.advanceTimersByTimeAsync(0);
            await pending;

            expect(settled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a send blocked on drain gives up after the timeout', async () => {
        vi.useFakeTimers();
        try {
            const [a, b] = pair();
            attachFraming(b as unknown as RTCDataChannel, () => {});
            const sender = attachFraming(a as unknown as RTCDataChannel, () => {});

            a.bufferedAmount = 8 * 1024 * 1024;

            let settled = false;
            const pending = sender.send({ body: 'x'.repeat(200 * 1024) }).then(() => {
                settled = true;
            });

            // One timeout window is enough: giving up abandons the whole
            // message rather than retrying per chunk, so a wedged channel
            // cannot cost DRAIN_TIMEOUT_MS once per chunk.
            await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 10);
            await pending;

            expect(settled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

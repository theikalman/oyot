import { describe, it, expect } from 'vitest';
import { attachFraming } from './Framing';

// Minimal RTCDataChannel stand-in: an EventTarget with send()/readyState that
// forwards each sent string to its wired partner as a 'message' event.
class FakeChannel extends EventTarget {
    readyState: RTCDataChannelState = 'open';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    partner: FakeChannel | null = null;

    send(data: string): void {
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
        attachFraming(b as unknown as RTCDataChannel, (m) => received.push(m as { id: string; body: string }));
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
});

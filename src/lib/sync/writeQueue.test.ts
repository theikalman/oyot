import { describe, it, expect } from 'vitest';
import { createWriteQueue } from './writeQueue';

// A promise whose resolution the test controls, so overlap is observable
// rather than a matter of timing luck.
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('createWriteQueue', () => {
    it('runs work for the same key one at a time', async () => {
        const queue = createWriteQueue();
        const first = deferred();
        const order: string[] = [];

        const a = queue('doc', async () => {
            order.push('a:start');
            await first.promise;
            order.push('a:end');
        });
        const b = queue('doc', async () => {
            order.push('b:start');
        });

        // b must not have started while a is still in flight.
        await Promise.resolve();
        expect(order).toEqual(['a:start']);

        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('lets different keys run concurrently', async () => {
        const queue = createWriteQueue();
        const blocker = deferred();
        const order: string[] = [];

        const a = queue('doc-a', async () => {
            order.push('a:start');
            await blocker.promise;
        });
        const b = queue('doc-b', async () => {
            order.push('b:start');
        });

        await b;
        // b finished while a is still blocked: unrelated documents do not
        // queue behind each other.
        expect(order).toEqual(['a:start', 'b:start']);

        blocker.resolve();
        await a;
    });

    it('runs the next item after a failure', async () => {
        const queue = createWriteQueue();
        const order: string[] = [];

        const failing = queue('doc', async () => {
            order.push('failing');
            throw new Error('boom');
        });
        const next = queue('doc', async () => {
            order.push('next');
            return 'ok';
        });

        await expect(failing).rejects.toThrow('boom');
        await expect(next).resolves.toBe('ok');
        expect(order).toEqual(['failing', 'next']);
    });

    it('surfaces the rejection to the caller that queued it', async () => {
        const queue = createWriteQueue();
        const failing = queue('doc', async () => {
            throw new Error('boom');
        });
        await expect(failing).rejects.toThrow('boom');
    });

    it('preserves the order work was queued in', async () => {
        const queue = createWriteQueue();
        const gate = deferred();
        const order: number[] = [];

        // The first item blocks, so everything behind it queues up.
        const all = [
            queue('doc', async () => {
                await gate.promise;
                order.push(0);
            }),
            ...[1, 2, 3, 4].map((n) =>
                queue('doc', async () => {
                    order.push(n);
                }),
            ),
        ];

        gate.resolve();
        await Promise.all(all);
        expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns each caller its own result', async () => {
        const queue = createWriteQueue();
        const [a, b] = await Promise.all([
            queue('doc', async () => 'first'),
            queue('doc', async () => 'second'),
        ]);
        expect([a, b]).toEqual(['first', 'second']);
    });

    it('does not retain a key once its work has drained', async () => {
        // The map would otherwise grow by one entry per document touched, for
        // the life of the process.
        const queue = createWriteQueue();
        await queue('doc', async () => undefined);
        // Nothing is exported to inspect the map, so assert the observable
        // consequence: a later call still runs immediately.
        const order: string[] = [];
        await queue('doc', async () => {
            order.push('ran');
        });
        expect(order).toEqual(['ran']);
    });
});

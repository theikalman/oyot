import { describe, expect, it, vi } from 'vitest';
import { flushPendingSaves, registerPendingSave } from './pendingSaves';

describe('pending saves', () => {
    it('flushes every registered editor and waits for the writes', async () => {
        const written: string[] = [];
        const offA = registerPendingSave(async () => {
            await Promise.resolve();
            written.push('a');
        });
        const offB = registerPendingSave(async () => {
            written.push('b');
        });

        await flushPendingSaves();
        expect(written.sort()).toEqual(['a', 'b']);
        offA();
        offB();
    });

    it('skips an editor with nothing to write', async () => {
        const flush = vi.fn(() => null);
        const off = registerPendingSave(flush);
        await flushPendingSaves();
        expect(flush).toHaveBeenCalledOnce();
        off();
    });

    it('does not let one failing save stop the others', async () => {
        const written: string[] = [];
        const offA = registerPendingSave(() => Promise.reject(new Error('disk full')));
        const offB = registerPendingSave(async () => {
            written.push('b');
        });

        await expect(flushPendingSaves()).resolves.toBeUndefined();
        expect(written).toEqual(['b']);
        offA();
        offB();
    });

    it('forgets an editor once it unregisters', async () => {
        const flush = vi.fn(() => null);
        registerPendingSave(flush)();
        await flushPendingSaves();
        expect(flush).not.toHaveBeenCalled();
    });
});

import { describe, expect, it, vi } from 'vitest';
import { createCloseFlow, type CloseFlowDeps, type CloseSettings } from './closeFlow';

function deps(settings: CloseSettings, answer = true) {
    const calls: string[] = [];
    const d: CloseFlowDeps = {
        acknowledge: vi.fn(async (id: number) => {
            calls.push(`ack ${id}`);
        }),
        flushPendingSaves: vi.fn(async () => {
            calls.push('flush');
        }),
        settings: vi.fn(async () => settings),
        askKeepRunning: vi.fn(async () => {
            calls.push('notice');
            return answer;
        }),
        answerNotice: vi.fn(async (keep: boolean) => {
            calls.push(`answer ${keep}`);
        }),
        finish: vi.fn(async (action) => {
            calls.push(`finish ${action}`);
        }),
    };
    return { d, calls };
}

describe('closing the window', () => {
    it('acknowledges, saves, then follows the setting once the notice was seen', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: true });
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['ack 1', 'flush', 'finish default']);
    });

    it('asks the first time, and keeps running on "Keep running"', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: false }, true);
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['ack 1', 'flush', 'notice', 'answer true', 'finish hide']);
    });

    it('quits on "Quit instead", and records the answer first', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: false }, false);
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['ack 1', 'flush', 'notice', 'answer false', 'finish quit']);
    });

    it('never shows the notice when keeping running is off', async () => {
        const { d, calls } = deps({ keepRunning: false, closeNoticeSeen: false });
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['ack 1', 'flush', 'finish default']);
    });

    it('acknowledges a second press while the notice is up, and ignores it', async () => {
        let answer: (keep: boolean) => void = () => {};
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: false });
        d.askKeepRunning = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    calls.push('notice');
                    answer = resolve;
                }),
        );
        const flow = createCloseFlow(d);

        const first = flow(1);
        await vi.waitFor(() => expect(calls).toContain('notice'));
        await flow(2);
        answer(true);
        await first;

        expect(calls).toEqual(['ack 1', 'flush', 'notice', 'ack 2', 'answer true', 'finish hide']);
    });

    it('still closes when the settings cannot be read', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: false });
        d.settings = vi.fn(async () => {
            throw new Error('no config');
        });
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['ack 1', 'flush', 'finish default']);
    });

    it('still handles the close when the acknowledgement fails', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: true });
        d.acknowledge = vi.fn(async () => {
            throw new Error('ipc');
        });
        await createCloseFlow(d)(1);
        expect(calls).toEqual(['flush', 'finish default']);
    });

    it('handles the next request once one has finished', async () => {
        const { d, calls } = deps({ keepRunning: true, closeNoticeSeen: true });
        const flow = createCloseFlow(d);
        await flow(1);
        await flow(2);
        expect(calls).toEqual([
            'ack 1',
            'flush',
            'finish default',
            'ack 2',
            'flush',
            'finish default',
        ]);
    });
});

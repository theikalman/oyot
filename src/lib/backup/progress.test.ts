import { describe, it, expect } from 'vitest';
import { describeProgress } from './progress';

describe('describeProgress', () => {
    it('says what is happening before anything is moving', () => {
        expect(describeProgress({ phase: 'building', done: 0, total: 0 })).toBe(
            'Preparing the backup…',
        );
    });

    it('gives a percentage once the size is known', () => {
        expect(describeProgress({ phase: 'uploading', done: 45, total: 100 })).toBe(
            'Uploading… 45%',
        );
        expect(describeProgress({ phase: 'downloading', done: 1, total: 3 })).toBe(
            'Downloading… 33%',
        );
    });

    it('leaves the percentage out when the size is not known', () => {
        expect(describeProgress({ phase: 'downloading', done: 5000, total: 0 })).toBe(
            'Downloading…',
        );
    });

    it('never claims more than all of it', () => {
        expect(describeProgress({ phase: 'uploading', done: 120, total: 100 })).toBe(
            'Uploading… 100%',
        );
    });
});

import { describe, it, expect } from 'vitest';
import { numberOf, textOf } from './attrValues';

const ownString = { toString: 'x' };
const noPrototype: unknown = Object.create(null);

describe('textOf', () => {
    it('keeps text as it is', () => {
        expect(textOf('')).toBe('');
        expect(textOf(' a\n')).toBe(' a\n');
    });

    it('reads a number or a boolean as what it spells', () => {
        expect(textOf(2024)).toBe('2024');
        expect(textOf(0)).toBe('0');
        expect(textOf(true)).toBe('true');
        expect(textOf(false)).toBe('false');
        expect(textOf(10n)).toBe('10');
    });

    it('reads nothing in anything else, without making a string of it', () => {
        for (const value of [
            null,
            undefined,
            NaN,
            Infinity,
            [],
            ['a'],
            {},
            ownString,
            noPrototype,
            new Uint8Array([1]),
        ]) {
            expect(textOf(value)).toBeNull();
        }
    });
});

describe('numberOf', () => {
    it('keeps a finite number as it is', () => {
        for (const value of [0, -1, 2.5, 1e12]) expect(numberOf(value)).toBe(value);
    });

    it('reads text that spells one', () => {
        expect(numberOf('3')).toBe(3);
        expect(numberOf(' 3 ')).toBe(3);
        expect(numberOf(10n)).toBe(10);
    });

    it('reads nothing in anything else, without making a number of it', () => {
        for (const value of [
            null,
            undefined,
            NaN,
            Infinity,
            '',
            ' ',
            '50%',
            true,
            [],
            [3],
            {},
            ownString,
            noPrototype,
            new Uint8Array([1]),
        ]) {
            expect(numberOf(value)).toBeNull();
        }
    });
});

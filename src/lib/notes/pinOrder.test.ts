import { describe, it, expect } from 'vitest';
import { comparePinned, pinMoves, positionBetween, positionsBetween } from './pinOrder';

function note(id: string, pin_position: string | null = null) {
    return { id, pin_position };
}

// The list after `moves` are written, read the way the sidebar reads it.
function applied(notes: ReturnType<typeof note>[], moves: ReturnType<typeof pinMoves>): string[] {
    const placed = new Map(moves.map((m) => [m.docId, m.position]));
    return notes
        .map((n) => ({ ...n, pin_position: placed.get(n.id) ?? n.pin_position }))
        .sort(comparePinned)
        .map((n) => n.id);
}

describe('comparePinned', () => {
    it('sorts by position, as plain strings', () => {
        const sorted = [note('c', '7'), note('a', '25'), note('b', '3')].sort(comparePinned);

        expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    });

    // Where a new pin lands, with nothing having to give it a place.
    it('puts a note with no position above every note with one', () => {
        const sorted = [note('placed', '1'), note('new')].sort(comparePinned);

        expect(sorted.map((n) => n.id)).toEqual(['new', 'placed']);
    });

    it('leaves notes with no position, or the same one, in the order they came', () => {
        const none = [note('b'), note('a')].sort(comparePinned);
        const same = [note('b', '5'), note('a', '5')].sort(comparePinned);

        expect(none.map((n) => n.id)).toEqual(['b', 'a']);
        expect(same.map((n) => n.id)).toEqual(['b', 'a']);
    });
});

describe('positionBetween', () => {
    it('finds the middle of an empty list', () => {
        expect(positionBetween(null, null)).toBe('5');
    });

    it.each([
        [null, '5'],
        ['5', null],
        ['5', '7'],
        ['5', '6'],
        ['5', '51'],
        ['05', '1'],
        ['09', '1'],
        ['1', '11'],
        ['499', '5'],
        ['9', null],
        [null, '01'],
    ])('sorts between %s and %s', (before, after) => {
        const position = positionBetween(before, after);

        if (before !== null) expect(position > before).toBe(true);
        if (after !== null) expect(position < after).toBe(true);
    });

    it('never ends in a zero, which nothing could be placed before', () => {
        for (const [before, after] of [
            ['5', '51'],
            [null, '01'],
            ['1', '2'],
        ]) {
            expect(positionBetween(before, after)).not.toMatch(/0$/);
        }
    });

    // Nothing makes this: it is what a damaged position gets instead of a
    // loop that never ends and takes the window with it.
    it.each([
        ['5', '5'],
        ['5', '50'],
    ])('refuses %s and %s, which have nothing between them', (before, after) => {
        expect(() => positionBetween(before, after)).toThrow();
    });

    // The same gap, again and again, from both ends: dragging a note back and
    // forth is what wears a gap down, and it must never run out.
    it('always has room, however often one gap is used', () => {
        let low: string | null = '5';
        let high: string | null = '6';
        for (let i = 0; i < 2000; i++) {
            const position = positionBetween(low, high);
            expect(position > (low as string)).toBe(true);
            expect(position < (high as string)).toBe(true);
            if (i % 2) low = position;
            else high = position;
        }
    });

    // Moving a note to the top or the bottom over and over.
    it('always has room at either end', () => {
        let first: string | null = null;
        let last: string | null = null;
        for (let i = 0; i < 2000; i++) {
            const top = positionBetween(null, first);
            if (first !== null) expect(top < first).toBe(true);
            first = top;

            const bottom = positionBetween(last, null);
            if (last !== null) expect(bottom > last).toBe(true);
            last = bottom;
        }
    });
});

describe('positionsBetween', () => {
    it('gives as many positions as it was asked for, in order', () => {
        const positions = positionsBetween('3', '4', 20);

        expect(positions).toHaveLength(20);
        expect([...positions].sort()).toEqual(positions);
        expect(new Set(positions).size).toBe(20);
        expect(positions[0] > '3').toBe(true);
        expect(positions[19] < '4').toBe(true);
    });

    it('gives none for none', () => {
        expect(positionsBetween(null, null, 0)).toEqual([]);
    });

    it('stays short for a long list', () => {
        const positions = positionsBetween(null, null, 100);

        expect(Math.max(...positions.map((p) => p.length))).toBeLessThanOrEqual(8);
    });
});

describe('pinMoves', () => {
    const placed = [note('a', '2'), note('b', '4'), note('c', '6'), note('d', '8')];

    it('writes only the note that moved', () => {
        const moves = pinMoves(placed, 3, 1);

        expect(moves.map((m) => m.docId)).toEqual(['d']);
        expect(applied(placed, moves)).toEqual(['a', 'd', 'b', 'c']);
    });

    it('moves a note down', () => {
        const moves = pinMoves(placed, 0, 2);

        expect(moves.map((m) => m.docId)).toEqual(['a']);
        expect(applied(placed, moves)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('moves a note to the top and to the bottom', () => {
        expect(applied(placed, pinMoves(placed, 2, 0))).toEqual(['c', 'a', 'b', 'd']);
        expect(applied(placed, pinMoves(placed, 1, 3))).toEqual(['a', 'c', 'd', 'b']);
    });

    it('writes nothing for a note put back where it was', () => {
        expect(pinMoves(placed, 2, 2)).toEqual([]);
    });

    // The list can shrink between picking a note up and letting it go.
    it('stops at the end of a list shorter than the place asked for', () => {
        expect(applied(placed, pinMoves(placed, 0, 99))).toEqual(['b', 'c', 'd', 'a']);
    });

    describe('in a list nobody has ordered yet', () => {
        const fresh = [note('a'), note('b'), note('c'), note('d')];

        it('places the note and the ones below it, so they stay below it', () => {
            const moves = pinMoves(fresh, 3, 1);

            expect(moves.map((m) => m.docId)).toEqual(['d', 'b', 'c']);
            expect(applied(fresh, moves)).toEqual(['a', 'd', 'b', 'c']);
        });

        it('places only the note when it goes to the bottom', () => {
            const moves = pinMoves(fresh, 0, 3);

            expect(moves.map((m) => m.docId)).toEqual(['a']);
            expect(applied(fresh, moves)).toEqual(['b', 'c', 'd', 'a']);
        });

        it('places every note when one goes to the top', () => {
            const moves = pinMoves(fresh, 2, 0);

            expect(moves).toHaveLength(4);
            expect(applied(fresh, moves)).toEqual(['c', 'a', 'b', 'd']);
        });
    });

    describe('with a new pin above a list already in order', () => {
        const list = [note('new'), note('a', '3'), note('b', '5'), note('c', '7')];

        it('leaves the new pin alone when a note moves below it', () => {
            const moves = pinMoves(list, 3, 1);

            expect(moves.map((m) => m.docId)).toEqual(['c']);
            expect(applied(list, moves)).toEqual(['new', 'c', 'a', 'b']);
        });

        it('places the new pin too when a note goes above it', () => {
            const moves = pinMoves(list, 2, 0);

            expect(moves.map((m) => m.docId)).toEqual(['b', 'new']);
            expect(applied(list, moves)).toEqual(['b', 'new', 'a', 'c']);
        });

        it('gives the new pin a place when it moves down', () => {
            const moves = pinMoves(list, 0, 2);

            expect(moves.map((m) => m.docId)).toEqual(['new']);
            expect(applied(list, moves)).toEqual(['a', 'b', 'new', 'c']);
        });
    });

    // Two devices that each moved a note into one gap can land on one
    // position, and there is nothing between a position and itself.
    it('makes room between two notes that took the same position', () => {
        const list = [note('a', '5'), note('b', '5'), note('c', '7'), note('d', '9')];
        const moves = pinMoves(list, 3, 1);

        expect(moves.map((m) => m.docId)).toEqual(['d', 'b']);
        expect(applied(list, moves)).toEqual(['a', 'd', 'b', 'c']);
    });

    // Every move from every place to every other, in lists part placed and
    // part not. Whatever the rules above missed, the list has to come out in
    // the order that was asked for.
    it('ends up as asked for, from any list, for any move', () => {
        const lists = [
            placed,
            [note('a'), note('b'), note('c'), note('d')],
            [note('a'), note('b', '3'), note('c', '5'), note('d', '7')],
            [note('a'), note('b'), note('c', '5'), note('d', '7')],
            [note('a'), note('b'), note('c'), note('d', '7')],
            [note('a', '5'), note('b', '5'), note('c', '5'), note('d', '5')],
            [note('a'), note('b', '5'), note('c', '5'), note('d', '51')],
        ];
        for (const list of lists) {
            for (let from = 0; from < list.length; from++) {
                for (let to = 0; to < list.length; to++) {
                    const wanted = list.map((n) => n.id);
                    wanted.splice(to, 0, wanted.splice(from, 1)[0]);

                    expect(applied(list, pinMoves(list, from, to))).toEqual(wanted);
                }
            }
        }
    });

    // A long run of moves, each starting from the list the last one left.
    it('keeps working move after move', () => {
        let list = [note('a'), note('b'), note('c'), note('d'), note('e')];
        let seed = 7;
        const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;

        for (let i = 0; i < 1000; i++) {
            const from = random(list.length);
            const to = random(list.length);
            const wanted = list.map((n) => n.id);
            wanted.splice(to, 0, wanted.splice(from, 1)[0]);

            const moves = pinMoves(list, from, to);
            const placedNow = new Map(moves.map((m) => [m.docId, m.position]));
            list = list
                .map((n) => ({ ...n, pin_position: placedNow.get(n.id) ?? n.pin_position }))
                .sort(comparePinned);

            expect(list.map((n) => n.id)).toEqual(wanted);
        }
    });
});

// Where a pinned note sits in the list the user put in order (ADR 0039).
//
// A position is a string of digits, read as the fraction after a decimal
// point. Positions sort as plain strings, and there is always another one
// between any two, so a move writes the note that moved and leaves its
// neighbours alone. That is what lets a note moved here and another moved on a
// phone both survive the next sync: each note's place is its own register.
//
// A note with no position has never been placed by hand. It sits above the
// ones that have, newest first, which is how a new pin reaches the top without
// anything having to work out a place for it, and how the list stays as it
// always was until the first time someone moves a note.
//
// Pure, for the reason the note index is: the order is a rule, and a page is
// only markup over it.

/** The part of a note its place in the list is decided by. */
interface Placed {
    id: string;
    pin_position: string | null;
}

/** One note's new place in the list. */
export interface PinMove {
    docId: string;
    position: string;
}

/**
 * Sorts notes with no position first and the rest by position. Notes this
 * calls equal, two with no position or two that took the same one on different
 * devices, stay in the order they came in, which every device agrees on.
 *
 * Compared as plain strings, not with `localeCompare`: Rust breaks a tie
 * between two positions on their bytes, and the two have to agree.
 */
export function comparePinned(a: Placed, b: Placed): number {
    if (a.pin_position === b.pin_position) return 0;
    if (a.pin_position === null) return -1;
    if (b.pin_position === null) return 1;
    return a.pin_position < b.pin_position ? -1 : 1;
}

/**
 * A position after `before` and ahead of `after`, null meaning there is
 * nothing on that side.
 *
 * It never ends in a zero, because no position could then be fitted in just
 * before it: nothing sorts between "5" and "50".
 */
export function positionBetween(before: string | null, after: string | null): string {
    const low = before ?? '';
    const high = after ?? '';
    let position = '';
    // Whether `position` is so far the start of `after`, so that the next
    // digit has to stay under after's.
    let bounded = after !== null;
    for (let i = 0; ; i++) {
        if (bounded && i >= high.length) {
            throw new Error(`There is no position between ${before} and ${after}`);
        }
        const lo = Number(low[i] ?? 0);
        const hi = bounded ? Number(high[i]) : 10;
        if (hi - lo > 1) return position + Math.floor((lo + hi) / 2);
        position += lo;
        bounded &&= lo === hi;
    }
}

/**
 * `count` positions in order between two others. Halved rather than taken one
 * after the next, so they stay about as short as they can be.
 */
export function positionsBetween(
    before: string | null,
    after: string | null,
    count: number,
): string[] {
    if (count <= 0) return [];
    const half = Math.floor(count / 2);
    const middle = positionBetween(before, after);
    return [
        ...positionsBetween(before, middle, half),
        middle,
        ...positionsBetween(middle, after, count - half - 1),
    ];
}

/**
 * What has to be written for the note at `from`, in a list in pinned order, to
 * sit at `to`.
 *
 * Usually one note: the one that moved. More only when notes below where it
 * lands cannot stay as they are: a note with no position always sorts above
 * one with a position, and two that took the same position have nothing
 * between them. Those are given places too, up to the first note that already
 * sorts below.
 */
export function pinMoves(notes: Placed[], from: number, to: number): PinMove[] {
    const target = Math.max(0, Math.min(to, notes.length - 1));
    if (from === target) return [];

    const next = [...notes];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);

    const before = next[target - 1]?.pin_position ?? null;
    const sortsBelow = (position: string | null) =>
        position !== null && (before === null || position > before);
    let end = target;
    while (end + 1 < next.length && !sortsBelow(next[end + 1].pin_position)) end++;

    const after = next[end + 1]?.pin_position ?? null;
    return positionsBetween(before, after, end - target + 1).map((position, i) => ({
        docId: next[target + i].id,
        position,
    }));
}

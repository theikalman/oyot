import { describe, it, expect } from 'vitest';
import { clearsPairField } from './pairingField';

describe('clearsPairField', () => {
    it('clears once a request has been accepted', () => {
        expect(clearsPairField('requesting', null)).toBe(true);
    });

    // The bug this rule was extracted for: idle is also null, so a condition
    // that only looked at the new state erased the field as it was typed into.
    it('does not clear while nothing has been attempted', () => {
        expect(clearsPairField(null, null)).toBe(false);
    });

    it('does not clear when a request is sent', () => {
        expect(clearsPairField(null, 'requesting')).toBe(false);
    });

    // Both leave the id in the field, which is the whole point: there is
    // something to retry with.
    it('does not clear when the other device declines', () => {
        expect(clearsPairField('requesting', 'declined')).toBe(false);
    });

    it('does not clear when nothing answers', () => {
        expect(clearsPairField('requesting', 'timed-out')).toBe(false);
    });

    it('does not clear when an unanswered request is given up on', () => {
        expect(clearsPairField('timed-out', null)).toBe(false);
        expect(clearsPairField('declined', null)).toBe(false);
    });
});

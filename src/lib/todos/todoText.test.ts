import { describe, it, expect } from 'vitest';
import {
    markSegments,
    markText,
    todoSegments,
    type MarkedRun,
    type MarkedSegment,
    type TodoSegment,
} from './todoText';
import { findAnyTerms, findTerms, searchTerms } from './todoSearch';

const text = (value: string): TodoSegment => ({ kind: 'text', text: value });
const tag = (name: string): TodoSegment => ({ kind: 'tag', name });

/** The segments put back together, the way the page reads them aloud. */
function spoken(segments: TodoSegment[]): string {
    return segments.map((s) => (s.kind === 'tag' ? `#${s.name}` : s.text)).join('');
}

describe('todoSegments', () => {
    it('leaves a todo with no hashes as it is', () => {
        expect(todoSegments('buy milk', ['urgent'])).toEqual([text('buy milk')]);
    });

    it('finds a tag the document carries', () => {
        expect(todoSegments('call mum #urgent', ['urgent'])).toEqual([
            text('call mum '),
            tag('urgent'),
        ]);
    });

    it('finds tags at the start, in the middle and side by side', () => {
        expect(todoSegments('#work plan #urgent#home', ['home', 'urgent', 'work'])).toEqual([
            tag('work'),
            text(' plan '),
            tag('urgent'),
            tag('home'),
        ]);
    });

    // A hash on its own is not a tag (ADR 0019): only a chip is, and every
    // chip in a todo is one of its document's tags.
    it("leaves a hash that spells none of the document's tags as words", () => {
        expect(todoSegments('fix issue #42 and #Urgent', ['urgent'])).toEqual([
            text('fix issue #42 and #Urgent'),
        ]);
    });

    it('draws nothing as a chip for a document with no tags', () => {
        expect(todoSegments('call mum #urgent', [])).toEqual([text('call mum #urgent')]);
    });

    it('reads the longest tag the text spells', () => {
        expect(todoSegments('#project x kickoff', ['project', 'project x'])).toEqual([
            tag('project x'),
            text(' kickoff'),
        ]);
    });

    it('does not cut a typed word short to make a chip of it', () => {
        expect(todoSegments('run the #workshop, #work-life, #work𝒳', ['work'])).toEqual([
            text('run the #workshop, #work-life, #work𝒳'),
        ]);
    });

    it('ends a tag at punctuation', () => {
        expect(todoSegments('ask #mum, #dad’s turn', ['dad', 'mum'])).toEqual([
            text('ask '),
            tag('mum'),
            text(', '),
            tag('dad'),
            text('’s turn'),
        ]);
    });

    it('has nothing to draw for no text', () => {
        expect(todoSegments('', ['urgent'])).toEqual([]);
    });

    // The chips change how a todo looks, never what it says.
    it('keeps every character of the text', () => {
        const tags = ['c#', 'project x', 'urgent', 'work'];
        for (const todo of [
            'learn #c# today',
            '#project x#urgent',
            'a # b ## c #',
            '#workshop and #work.',
            'emoji #urgent🎉 #work𝒳',
        ]) {
            expect(spoken(todoSegments(todo, tags))).toBe(todo);
        }
    });
});

describe('markSegments', () => {
    const plain = (value: string): MarkedRun => ({ text: value, match: false });
    const found = (value: string): MarkedRun => ({ text: value, match: true });

    /** A todo drawn as the page draws it while `query` is searched for. */
    function marked(todo: string, tags: string[], query: string): MarkedSegment[] {
        const finds = findTerms(todo, searchTerms(query)) ?? [];
        return markSegments(todoSegments(todo, tags), finds);
    }

    it('marks nothing when nothing is searched for', () => {
        expect(marked('call mum #urgent', ['urgent'], '')).toEqual([
            { kind: 'text', runs: [plain('call mum ')] },
            { kind: 'tag', name: 'urgent', runs: [plain('#urgent')] },
        ]);
    });

    it('marks each find in the words', () => {
        expect(marked('call the bank, then the bank again', [], 'bank')).toEqual([
            {
                kind: 'text',
                runs: [
                    plain('call the '),
                    found('bank'),
                    plain(', then the '),
                    found('bank'),
                    plain(' again'),
                ],
            },
        ]);
    });

    it('marks a find inside a chip, which is spelled with its hash', () => {
        expect(marked('call mum #urgent', ['urgent'], 'urg')).toEqual([
            { kind: 'text', runs: [plain('call mum ')] },
            { kind: 'tag', name: 'urgent', runs: [plain('#'), found('urg'), plain('ent')] },
        ]);
    });

    // A chip can come straight after a word, and one find can cover both.
    it('marks a find that runs from the words into a chip', () => {
        expect(marked('call mum#urgent', ['urgent'], 'mum#urg')).toEqual([
            { kind: 'text', runs: [plain('call '), found('mum')] },
            { kind: 'tag', name: 'urgent', runs: [found('#urg'), plain('ent')] },
        ]);
    });

    // Marking changes how a todo looks, never what it says.
    it('keeps every character of the text', () => {
        const tags = ['project x', 'urgent'];
        for (const [todo, query] of [
            ['#project x#urgent and more', 'ect x#u more'],
            ['Café latte'.normalize('NFD'), 'cafe'],
            ['🎉 party #urgent', 'art urg'],
        ]) {
            const text = marked(todo, tags, query)
                .flatMap((segment) => segment.runs)
                .map((run) => run.text)
                .join('');
            expect(text).toBe(todo);
        }
    });
});

describe('markText', () => {
    const plain = (value: string): MarkedRun => ({ text: value, match: false });
    const found = (value: string): MarkedRun => ({ text: value, match: true });

    // How the Search page draws a tag it found: the chip, with its hash, and
    // the part of the name that matched.
    it('marks the finds in a piece of text drawn whole', () => {
        const chip = '#homework';
        expect(markText(chip, findAnyTerms(chip, searchTerms('work urgent')))).toEqual([
            plain('#home'),
            found('work'),
        ]);
    });

    it('leaves the text as one run when nothing was found', () => {
        expect(markText('#home', [])).toEqual([plain('#home')]);
    });
});

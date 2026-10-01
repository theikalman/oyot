import { describe, it, expect } from 'vitest';
import { findAnyTerms, findTerms, hasTerms, searchSections, searchTerms } from './todoSearch';
import { groupTodos, type TodoHit, type TodoSections } from './grouping';

/** What each find covers, which reads more plainly than its offsets. */
function marked(text: string, query: string): string[] | null {
    const found = findTerms(text, searchTerms(query));
    return found && found.map((range) => text.slice(range.start, range.end));
}

describe('searchTerms', () => {
    it('takes each word of the query', () => {
        expect(searchTerms('  call   the bank ')).toEqual(['call', 'the', 'bank']);
    });

    it('folds case and accents the way a todo is folded', () => {
        expect(searchTerms('Café CRÈME')).toEqual(['cafe', 'creme']);
    });

    it('has nothing to look for in a blank query', () => {
        expect(searchTerms('')).toEqual([]);
        expect(searchTerms('   ')).toEqual([]);
    });

    it('looks for a word once, however often it is typed', () => {
        expect(searchTerms('milk Milk')).toEqual(['milk']);
    });
});

describe('findTerms', () => {
    it('finds a word whatever its case', () => {
        expect(marked('Call the BANK', 'bank')).toEqual(['BANK']);
    });

    it('finds every word, in any order', () => {
        expect(marked('call the bank', 'bank call')).toEqual(['call', 'bank']);
    });

    it('finds nothing unless every word is there', () => {
        expect(findTerms('call the bank', searchTerms('bank mum'))).toBeNull();
    });

    it('finds part of a word, at its start or inside it', () => {
        expect(marked('restart the router', 'rout start')).toEqual(['start', 'rout']);
    });

    it('ignores accents in the todo and in the query', () => {
        expect(marked('Café with Zoë', 'cafe zoe')).toEqual(['Café', 'Zoë']);
        expect(marked('cafe with zoe', 'café zoë')).toEqual(['cafe', 'zoe']);
    });

    it('marks every place a word is', () => {
        expect(marked('milk, and more milk', 'milk')).toEqual(['milk', 'milk']);
    });

    it('joins finds that overlap or touch', () => {
        expect(marked('milk', 'mi lk')).toEqual(['milk']);
        expect(marked('aaa', 'aa')).toEqual(['aaa']);
    });

    // Text pasted from some places spells é as an e and an accent after it.
    it('keeps an accent written as a mark of its own with its letter', () => {
        const text = 'Café latte'.normalize('NFD');
        expect(marked(text, 'cafe')).toEqual(['Café'.normalize('NFD')]);
    });

    // An emoji is two code units and folds to two, a Hangul syllable is one
    // and folds to two or three. The finds are offsets into the text as
    // written.
    it('gives offsets into the text as it is written', () => {
        expect(findTerms('🎉 party', searchTerms('party'))).toEqual([{ start: 3, end: 8 }]);
        expect(marked('한국어 공부', '국어')).toEqual(['국어']);
    });

    // Typing Korean passes through part of a syllable: 하 on the way to 한.
    it('marks the whole of a character that a find ends partway through', () => {
        expect(marked('한국', '하')).toEqual(['한']);
    });

    // A chip is spelled `#name` in a todo's text.
    it('finds a tag by its name, or spelled with its hash', () => {
        expect(marked('call mum #urgent', 'urg')).toEqual(['urg']);
        expect(marked('call mum #urgent', '#urg')).toEqual(['#urg']);
    });

    it('finds any todo, and marks nothing in it, for no words', () => {
        expect(findTerms('call the bank', [])).toEqual([]);
    });
});

describe('findAnyTerms', () => {
    const covered = (text: string, query: string) =>
        findAnyTerms(text, searchTerms(query)).map((range) => text.slice(range.start, range.end));

    // A document's tags share a search's words between them: `work home`
    // finds a note tagged #work and #home, and each chip marks its own word.
    it('finds the words that are there, though others are not', () => {
        expect(covered('homework', 'work urgent')).toEqual(['work']);
    });

    it('finds nothing, rather than failing, when no word is there', () => {
        expect(findAnyTerms('homework', searchTerms('urgent'))).toEqual([]);
    });

    it('folds and joins as findTerms does', () => {
        expect(covered('Café crème', 'cafe crem')).toEqual(['Café', 'crèm']);
        expect(covered('milk', 'mi lk')).toEqual(['milk']);
    });

    it('agrees with findTerms when every word is there', () => {
        const terms = searchTerms('bank call');
        expect(findAnyTerms('call the bank', terms)).toEqual(findTerms('call the bank', terms));
    });

    it('passes over an empty word instead of finding it everywhere', () => {
        expect(findAnyTerms('milk', ['', 'mi'])).toEqual([{ start: 0, end: 2 }]);
    });
});

describe('hasTerms', () => {
    // The quick answer the list is filtered by, and the one the marks come
    // from, have to agree about every todo.
    it('says a todo is found exactly when findTerms finds it', () => {
        const cases: [string, string][] = [
            ['Call the BANK', 'bank'],
            ['call the bank', 'bank mum'],
            ['Café latte'.normalize('NFD'), 'cafe'],
            ['한국어 공부', '국어'],
            ['call mum #urgent', '#urg'],
            ['buy milk', ''],
            ['', 'milk'],
        ];
        for (const [text, query] of cases) {
            const terms = searchTerms(query);
            expect(hasTerms(text, terms), `${text} / ${query}`).toBe(
                findTerms(text, terms) !== null,
            );
        }
    });
});

describe('searchSections', () => {
    function hit(docId: string, docType: string, ordinal: number, text: string, checked = false) {
        const todo: TodoHit = {
            document_id: docId,
            document_title: docId.toUpperCase(),
            doc_type: docType,
            ordinal,
            text,
            checked,
            depth: 0,
        };
        return todo;
    }

    const sections = groupTodos(
        [
            hit('j1', 'journal', 0, 'call the bank'),
            hit('j1', 'journal', 1, 'buy #milk', true),
            hit('n1', 'note', 0, 'fix the roof'),
            hit('n2', 'note', 0, 'milk the cows'),
            hit('n2', 'note', 1, 'feed the hens'),
        ],
        new Map([['j1', ['milk']]]),
    );

    const texts = (found: TodoSections) =>
        [...found.journals, ...found.notes].map((g) => [g.docId, g.todos.map((t) => t.text)]);

    it('keeps the todos with every word, under the headings they had', () => {
        expect(texts(searchSections(sections, searchTerms('milk')))).toEqual([
            ['j1', ['buy #milk']],
            ['n2', ['milk the cows']],
        ]);
    });

    it('leaves out a heading with nothing found under it', () => {
        const found = searchSections(sections, searchTerms('the roof'));
        expect(found.journals).toEqual([]);
        expect(found.notes.map((g) => g.docId)).toEqual(['n1']);
    });

    // The rows still draw their chips and open their notes.
    it("keeps each group's title and tags", () => {
        const [journal] = searchSections(sections, searchTerms('milk')).journals;
        expect(journal.title).toBe('J1');
        expect(journal.tags).toEqual(['milk']);
    });

    // Hide completed is the page's to apply, after the search, so the page
    // can say when everything the search found is finished.
    it('finds finished todos as well as open ones', () => {
        const [journal] = searchSections(sections, searchTerms('buy')).journals;
        expect(journal.todos.map((t) => t.checked)).toEqual([true]);
    });

    it('keeps everything, as it came, for no words', () => {
        expect(searchSections(sections, [])).toBe(sections);
    });
});

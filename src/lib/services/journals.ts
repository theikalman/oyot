import { get } from 'svelte/store';
import { documents } from '../stores/app';
import { createJournalForDate } from './documentActions';
import { openDocument } from './navigation';

/**
 * Open the journal for the day `title` names (`YYYY-MM-DD`), starting one if
 * there is none yet, which is what picking a day in the calendar does.
 *
 * Starting one is safe to repeat: a journal's id comes from its date, so a
 * day started here and on another device is one journal, not two.
 */
export async function openJournal(title: string): Promise<void> {
    const existing = get(documents).find((d) => d.doc_type === 'journal' && d.title === title);
    const id = existing?.id ?? (await createJournalForDate(title)).id;
    await openDocument(id);
}

import type { ImportResult, SkippedFile, SkipReason } from './importFiles';

/**
 * What to tell the user once an import is done.
 *
 * Pure, so the wording can be tested; the pages show it as toasts. Every
 * file that did not come in is named, and every image that did not come in
 * as a picture is counted: an import that quietly brought in less than was
 * picked is worse than one that says so.
 */
export interface ImportReport {
    /** What was imported, when anything was. */
    success: string | null;
    /** Said when nothing was imported at all. */
    failure: string | null;
    /** What came in partly, or not at all. */
    warnings: string[];
}

/** Why a file was skipped, after "it" or "they". */
const REASONS: Record<SkipReason, { one: string; many: string }> = {
    'not-text': { one: 'it is not text', many: 'they are not text' },
    'too-large': { one: 'it is larger than 8 MB', many: 'they are larger than 8 MB' },
    unreadable: { one: 'it could not be opened', many: 'they could not be opened' },
    failed: { one: 'something went wrong reading it', many: 'something went wrong reading them' },
};

export function describeImport(result: ImportResult): ImportReport {
    const { notes, skipped, imagesKeptAsText, missingImages } = result;
    const warnings: string[] = [];

    for (const reason of Object.keys(REASONS) as SkipReason[]) {
        const files = skipped.filter((file) => file.reason === reason);
        if (files.length === 0) continue;
        const why = files.length === 1 ? REASONS[reason].one : REASONS[reason].many;
        warnings.push(`Could not import ${fileList(files)}: ${why}.`);
    }

    if (imagesKeptAsText > 0) {
        const were = imagesKeptAsText === 1 ? 'was' : 'were';
        warnings.push(
            `${count(imagesKeptAsText, 'image')} ${were} kept as text. Oyot cannot bring in ` +
                'a picture from a file beside a note, or from the web.',
        );
    }
    if (missingImages > 0) {
        const [are, them] = missingImages === 1 ? ['is', 'it'] : ['are', 'them'];
        warnings.push(
            `${count(missingImages, 'image')} ${are} not on this device, and will appear if a ` +
                `paired device has ${them}.`,
        );
    }

    if (notes.length === 0) {
        return { success: null, failure: 'No notes were imported.', warnings };
    }
    const success =
        notes.length === 1
            ? `Imported ${notes[0].title}`
            : `Imported ${count(notes.length, 'note')}`;
    return { success, failure: null, warnings };
}

/** Up to three files by name, and how many more. */
function fileList(files: SkippedFile[]): string {
    const named = files.map((file) => file.name).filter((name) => name.length > 0);
    const shown = named.slice(0, 3);
    const rest = files.length - shown.length;
    if (shown.length === 0) return rest === 1 ? 'a file' : `${rest} files`;
    if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
    if (shown.length === 1) return shown[0];
    return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

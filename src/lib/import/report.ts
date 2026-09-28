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
    /** What came in, or that nothing did. */
    headline: string;
    /** Whether anything came in, which decides how the headline is shown. */
    imported: boolean;
    /**
     * What came in partly, or not at all: one line for the files skipped and
     * one for each way an image did not come in as a picture. Never more than
     * three, so with the headline they fit among the toasts shown at once.
     */
    warnings: string[];
}

/**
 * Why a file was skipped, after "it" or "they". The size is Rust's
 * `MAX_FILE_BYTES` in `commands/import.rs`, which decides it.
 */
const REASONS: Record<SkipReason, { one: string; many: string }> = {
    'not-text': { one: 'it is not text', many: 'they are not text' },
    'too-large': { one: 'it is larger than 8 MB', many: 'they are larger than 8 MB' },
    unreadable: { one: 'it could not be opened', many: 'they could not be opened' },
    failed: { one: 'something went wrong reading it', many: 'something went wrong reading them' },
};

export function describeImport(result: ImportResult): ImportReport {
    const { notes, skipped, imagesKeptAsText, missingImages } = result;
    const warnings: string[] = [];

    const skips: string[] = [];
    for (const reason of Object.keys(REASONS) as SkipReason[]) {
        const files = skipped.filter((file) => file.reason === reason);
        if (files.length === 0) continue;
        const why = files.length === 1 ? REASONS[reason].one : REASONS[reason].many;
        skips.push(`Could not import ${fileList(files)}: ${why}.`);
    }
    if (skips.length > 0) warnings.push(skips.join(' '));

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
        return { headline: 'No notes were imported.', imported: false, warnings };
    }
    const headline =
        notes.length === 1
            ? `Imported ${notes[0].title}`
            : `Imported ${count(notes.length, 'note')}`;
    return { headline, imported: true, warnings };
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

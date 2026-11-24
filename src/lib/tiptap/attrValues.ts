// What a node's attribute says, whatever it turns out to hold.
//
// An attribute is whatever JSON a paste or a paired device put there. An
// array or an object is never turned into a string here: one with a
// `toString` of its own throws when it is, and one without says nothing
// worth reading.
//
// Pure, like `attachmentRef.ts`, so the document index and the sync path can
// read an attribute without importing the editor.

/**
 * `value` as text, or null if it is not any.
 *
 * A number or a boolean is: Tiptap reads an HTML attribute that spells one as
 * one, so a pasted `alt="2024"` arrives as the number.
 */
export function textOf(value: unknown): string | null {
    switch (typeof value) {
        case 'string':
            return value;
        case 'number':
            return Number.isFinite(value) ? String(value) : null;
        case 'boolean':
        case 'bigint':
            return String(value);
        default:
            return null;
    }
}

/** `value` as a finite number, or null if it is not one and does not spell one. */
export function numberOf(value: unknown): number | null {
    let number: number;
    switch (typeof value) {
        case 'number':
            number = value;
            break;
        case 'bigint':
            number = Number(value);
            break;
        case 'string':
            if (value.trim() === '') return null;
            number = Number(value);
            break;
        default:
            return null;
    }
    return Number.isFinite(number) ? number : null;
}

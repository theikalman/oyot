/**
 * A short string that stands for a longer one: for telling one piece of code
 * from another in a key, not for security. It only has to tell them apart, and
 * the length beside the hash makes a collision less likely still.
 */
export function sourceKey(source: string): string {
    return `${fnv1a(source)}:${source.length}`;
}

// FNV-1a, 32 bits.
function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

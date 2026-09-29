/**
 * The colour schemes the user can choose from (ADR 0036). Their colours are in
 * schemes.css, one block per id; this is what the rest of the app needs to
 * know about them.
 */

export const COLOR_SCHEMES = [
    { id: 'catppuccin-latte', family: 'Catppuccin', name: 'Latte', appearance: 'light' },
    { id: 'catppuccin-frappe', family: 'Catppuccin', name: 'Frappé', appearance: 'dark' },
    { id: 'catppuccin-macchiato', family: 'Catppuccin', name: 'Macchiato', appearance: 'dark' },
    { id: 'catppuccin-mocha', family: 'Catppuccin', name: 'Mocha', appearance: 'dark' },
    { id: 'solarized-light', family: 'Solarized', name: 'Light', appearance: 'light' },
    { id: 'solarized-dark', family: 'Solarized', name: 'Dark', appearance: 'dark' },
] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type ColorSchemeId = ColorScheme['id'];
export type Appearance = ColorScheme['appearance'];

/** What a device that never chose a scheme gets. */
export const DEFAULT_COLOR_SCHEME: ColorSchemeId = 'catppuccin-macchiato';

/**
 * Before there were schemes the choice was light or dark, and it is still in
 * config.json and in older backups under those names. Each becomes the
 * Catppuccin scheme closest to it: Latte for light, and the default for dark.
 */
const LEGACY: Record<string, ColorSchemeId> = {
    light: 'catppuccin-latte',
    dark: 'catppuccin-macchiato',
};

/** The scheme a stored value names, or null when it names none this build knows. */
export function parseColorScheme(value: unknown): ColorSchemeId | null {
    if (typeof value !== 'string') return null;
    if (value in LEGACY) return LEGACY[value];
    return COLOR_SCHEMES.some((s) => s.id === value) ? (value as ColorSchemeId) : null;
}

export function colorScheme(id: ColorSchemeId): ColorScheme {
    return COLOR_SCHEMES.find((s) => s.id === id) ?? colorScheme(DEFAULT_COLOR_SCHEME);
}

/** The schemes grouped by family, in the order they are listed. */
export function colorSchemeFamilies(): { family: string; schemes: ColorScheme[] }[] {
    const families: { family: string; schemes: ColorScheme[] }[] = [];
    for (const scheme of COLOR_SCHEMES) {
        const last = families.at(-1);
        if (last?.family === scheme.family) last.schemes.push(scheme);
        else families.push({ family: scheme.family, schemes: [scheme] });
    }
    return families;
}

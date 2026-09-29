# 0036: Colour schemes the user can choose, Catppuccin Macchiato by default

- **Status:** Proposed
- **Date:** 2026-09-29

## Context

The app had one light palette and one dark palette, written as CSS variables
in `app.css`, and Settings had a button that switched between them. A
device that had never chosen followed the system's light or dark setting.
Around twenty components also named colours of their own: toasts, the
peer-status pills, the About dialog's change badges, the delete buttons,
white text on every primary button. Those kept their colours whatever the
palette, and a few had dark-mode overrides of their own.

The request was a colour scheme selector in Settings with presets, starting
with Solarized and Catppuccin, each in light and dark, and Catppuccin
Macchiato as the default.

That leaves five things to decide: what a scheme is, how many there are,
where the colours live, what a device that never chose gets, and what
happens to the light or dark already stored.

## Decision

**1. A scheme is one complete set of the app's colour variables,** a block in
`src/lib/theme/schemes.css` selected by `data-scheme` on the root element.
Every block defines every variable, and nothing outside that file names a
colour, so a scheme is the whole look rather than a few overrides. The
components' own colours became variables: text on the accent (`--on-accent`)
and on the delete colour (`--on-danger`), a pale fill with text that reads
on it for success, warning, error and information (`--ok-bg`, `--ok-text`
and so on), the delete button's hover. Overlays and shadows stay black at a
low opacity, which works on every scheme. The QR code stays black on white,
because that is what cameras read best.

`data-theme` stays on the root element, as `light` or `dark` from the
scheme, for the rules that differ by that alone, such as how deep a toast's
shadow is. The block also sets CSS `color-scheme`, so scrollbars and form
controls match.

**2. Six schemes:** Catppuccin Latte, Frappé, Macchiato and Mocha, and
Solarized Light and Dark. Catppuccin's four flavours are what the scheme
is; offering one light and one dark of it would leave out the two its users
most often mean. Each is listed in `src/lib/theme/schemes.ts` with its
family and whether it is light or dark, and the picker groups them by
family.

**3. The colours are the published palettes, used as their guides say,**
nudged where they do not read. Catppuccin: base, mantle and crust for
surfaces, text and subtext for words, blue for the accent, peach for a task
still to do. Solarized: base03 to base3 for surfaces and words, blue for the
accent, orange for a task still to do. Where a colour falls below the
contrast its use needs (4.5:1 for words, 3:1 for the accent and small
marks), it is moved towards the text colour until it passes: Latte's
subtext and peach, Solarized Light's secondary text. `schemes.test.ts`
checks those pairs in every scheme, so a scheme added later is held to the
same.

**4. A device that never chose gets Catppuccin Macchiato,** whatever the
system's light or dark setting. The request named the default, and a
default picked by the system would give half of new users Latte. Macchiato
also stands in for `:root`, so the page is already right before the
bootstrap script runs.

**5. What is stored keeps its key.** `config.json`'s `theme` holds the
scheme's id, and the bootstrap script in `app.html` still reads the
`oyot:theme` mirror in localStorage before the first paint. `light` and
`dark`, stored before there were schemes, are read as Catppuccin Latte and
Macchiato, the nearest of the new ones, by Rust, by the page and by the
bootstrap script. Saving takes only a scheme id, so the old names go away
the first time the user picks one. Backups carry the id the same way; an
older build reading a newer backup drops a value it does not know, as it
always has, and one that was never chosen stays never chosen, so a backup's
scheme is still only taken on a device that never chose one.

## Alternatives considered

**A family and a light or dark switch,** Catppuccin or Solarized, then
light, dark or follow the system. Rejected: Catppuccin has three dark
flavours, so the switch would need a third control to say which, and
following the system would make the named default apply only at night.

**Keeping the old light and dark palettes as schemes of their own.** Not
now. They were not asked for, and each scheme is a set of colours to keep
readable; they can come back as a block each.

**Defining the colours in TypeScript and setting them from script.** One
place for the list and the colours, but the page would render once without
them, and the bootstrap script would have to carry every colour of every
scheme to avoid a flash. CSS applies before anything paints.

**Mixing tints with `color-mix()`,** so each scheme needs its base colours
only. Rejected for now: it needs Safari 16.2, and the app supports macOS
back to 10.13, where the web view is older. The tints are written out
instead.

## Consequences

- A new scheme is a block in `schemes.css`, an entry in `schemes.ts`, its id
  in `app.html`'s bootstrap script and in `COLOR_SCHEMES` in Rust's
  `commands/config.rs`. The tests fail if any of the four disagree, if the
  block leaves a variable out, or if a text pair falls under its contrast.
- A new colour in a component is a variable in every block, which the test
  enforces for the ones in the default block.
- Users who had chosen dark get Macchiato instead of the old grey dark
  palette, and those who had chosen light get Latte. Users who had never
  chosen, on a light system, now start dark.
- Colours are per device and not synced, as before.

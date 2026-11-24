/**
 * Showing a piece of HTML as the page it makes, in a frame it cannot reach out
 * of.
 *
 * Notes arrive from paired devices and through MCP, so the HTML is hostile.
 * Three things hold it, any one of which is enough to keep a script it brings
 * from running: the frame is sandboxed without `allow-scripts`, the page in it
 * inherits the app's content security policy, and it begins with a policy of
 * its own that allows its styles and the pictures inside it and nothing else.
 * See docs/decisions/0043-show-html-code-blocks-as-pages-while-reading.md.
 */

/**
 * What the frame allows. The page keeps the app's origin, so that this side
 * can read how tall it is and disarm its links, which is safe because nothing
 * on its side can run: never add `allow-scripts` beside it.
 */
const SANDBOX = 'allow-same-origin';

/**
 * What every previewed page begins with, ahead of anything it says itself.
 *
 * The `<base>` has to come first, as the first one counts. An address within
 * the page still works against it, and a relative one resolves to nothing,
 * where it would otherwise be an address in the app. Its target is a new
 * window, which the sandbox does not let a page open: see `disarmLinks`.
 */
const PRELUDE =
    '<base href="about:srcdoc" target="_blank">' +
    '<meta http-equiv="Content-Security-Policy" ' +
    "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";

/** The tallest a preview in a note is before it scrolls, and the shortest. */
const MAX_HEIGHT = 480;
const MIN_HEIGHT = 64;

const XLINK = 'http://www.w3.org/1999/xlink';

/** The document a frame is given to show `source`. */
export function previewDocument(source: string): string {
    // A document in a frame like this one is in standards mode without a
    // doctype, so the page's own coming after changes nothing.
    return PRELUDE + source;
}

/** A frame that shows `source`, at whatever size it is given. */
export function createFrame(source: string): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'HTML page';
    frame.addEventListener('load', () => {
        const page = pageIn(frame);
        if (!page) return;
        disarmLinks(page);
        const title = page.querySelector('title')?.textContent?.trim();
        if (title) frame.title = title;
    });
    frame.srcdoc = previewDocument(source);
    return frame;
}

/** Keep a frame as tall as its page, up to a limit, as its width changes. */
export function fitToPage(frame: HTMLIFrameElement): void {
    frame.style.height = `${MAX_HEIGHT}px`;
    let width = -1;
    const fit = () => {
        const page = pageIn(frame);
        if (!page) return;
        width = frame.clientWidth;
        // Measured at the full height, which is what a page as tall as its
        // window takes the window to be.
        frame.style.height = `${MAX_HEIGHT}px`;
        if (page.scrollHeight > page.clientHeight) return;
        const tall = Math.ceil(page.getBoundingClientRect().height);
        frame.style.height = `${Math.min(Math.max(tall, MIN_HEIGHT), MAX_HEIGHT)}px`;
    };
    frame.addEventListener('load', fit);
    new ResizeObserver(() => {
        if (frame.isConnected && frame.clientWidth !== width) fit();
    }).observe(frame);
}

/**
 * The root of the page in a frame.
 *
 * Asked for through `Document.prototype`, because a page can name an element
 * after one of its document's own properties and be found there instead.
 */
function pageIn(frame: HTMLIFrameElement): HTMLElement | null {
    const page = frame.contentDocument;
    return page ? (Document.prototype.querySelector.call(page, 'html') as HTMLElement) : null;
}

/**
 * Make every link out of a page lead nowhere, and say where it led.
 *
 * Nothing it points at can open in the frame, and some engines show their own
 * error in place of the page when it is tried. Opening one in the browser
 * instead would need to hear the click, and WebKit tells nobody about events
 * in a frame that cannot run scripts. So each is aimed at a new window, which
 * the sandbox refuses without a trace. It stays a link, so the page's own
 * styles for one still apply, and the address is there on hovering over it.
 */
export function disarmLinks(page: Element): void {
    for (const link of page.querySelectorAll('a, area')) {
        const address = (
            link.getAttribute('href') ??
            link.getAttributeNS(XLINK, 'href') ??
            ''
        ).trim();
        if (address === '') continue;
        if (address.startsWith('#')) {
            link.setAttribute('target', '_self');
            continue;
        }
        link.setAttribute('target', '_blank');
        if (!link.hasAttribute('title')) link.setAttribute('title', address);
    }
}

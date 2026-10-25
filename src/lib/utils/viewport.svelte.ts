// Whether the window is phone-sized, as one reactive value every page can
// read, so a page that draws something different on a phone does not each
// keep its own media query.

const PHONE_QUERY = '(max-width: 768px)';

let phone = $state(typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);

if (typeof window !== 'undefined') {
    window.matchMedia(PHONE_QUERY).addEventListener('change', (e) => (phone = e.matches));
}

export const viewport = {
    /** Phone-sized: the sidebar is a drawer and the tab bar is shown. */
    get phone() {
        return phone;
    },
};

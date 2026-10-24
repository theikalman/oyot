// Whether the quick switcher is open. One for the whole app, opened by its
// keys from anywhere and by the search box at the top of the sidebar.

let open = $state(false);

export const switcher = {
    get open() {
        return open;
    },
    show() {
        open = true;
    },
    hide() {
        open = false;
    },
};

// What the app's Rust library offers this plugin (src-tauri/src/mobile.rs).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// One background run. Blocks until it ends and returns its record as JSON,
// to be handed back to oyot_string_free.
char *oyot_background_run(const char *data_dir, const char *trigger, uint64_t budget_ms,
                          bool images);
void oyot_string_free(char *s);

// End the run in progress early.
void oyot_background_stop(void);

// The app came on screen. Returns at once. Main thread.
void oyot_app_foreground(void);

// The app left the screen. Returns at once. Main thread.
void oyot_app_leaving(void);

// Let a sync in progress finish and go idle, returning then. Off the main
// thread, inside background time the caller asked for.
void oyot_app_finish_leaving(uint64_t budget_ms);

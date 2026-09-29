fn main() {
    // No commands: nothing here is for the webview to call.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}

mod commands;
mod db;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_all_documents,
            get_document,
            create_document,
            update_document,
            delete_document,
            search_documents,
            get_backlinks,
            get_journals,
            get_or_create_today_journal,
            get_recent_workspaces,
            save_recent_workspace,
            get_theme,
            save_theme,
            get_app_data_dir,
            get_workspace_dir,
            save_image,
            delete_image,
            cleanup_orphaned_images,
            get_attachment_path,
            request_attachment,
            set_current_workspace,
            init_database
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub path: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinkReference {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub line_number: usize,
    pub line_content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexData {
    pub files: Vec<FileEntry>,
    pub backlinks: Vec<LinkReference>,
    pub all_links: Vec<String>,
}

fn extract_title(content: &str, path: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            return trimmed[2..].trim().to_string();
        }
    }
    PathBuf::from(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let re = Regex::new(r"\[\[(.+?)\]\]").unwrap();
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

#[tauri::command]
fn scan_directory(dir_path: String) -> Result<IndexData, String> {
    let path = PathBuf::from(&dir_path);
    if !path.exists() {
        return Err("Directory does not exist".to_string());
    }

    let mut files: Vec<FileEntry> = Vec::new();
    let mut backlinks: Vec<LinkReference> = Vec::new();
    let mut all_links: std::collections::HashSet<String> = std::collections::HashSet::new();

    let walker = WalkDir::new(&path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'));

    for entry in walker.filter_map(|e| e.ok()) {
        let file_path = entry.path();
        if file_path.is_file() {
            if let Some(ext) = file_path.extension() {
                if ext == "md" || ext == "markdown" {
                    if let Ok(content) = std::fs::read_to_string(file_path) {
                        let path_str = file_path.to_string_lossy().to_string();
                        let title = extract_title(&content, &path_str);
                        let links = extract_wikilinks(&content);

                        for link in &links {
                            all_links.insert(link.clone());
                            backlinks.push(LinkReference {
                                source: path_str.clone(),
                                target: link.clone(),
                            });
                        }

                        files.push(FileEntry {
                            path: path_str,
                            title,
                            content,
                        });
                    }
                }
            }
        }
    }

    let mut unique_links: Vec<String> = all_links.into_iter().collect();
    unique_links.sort();

    Ok(IndexData {
        files,
        backlinks,
        all_links: unique_links,
    })
}

#[tauri::command]
fn get_file_content(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_content(dir_path: String, query: String) -> Result<Vec<SearchResult>, String> {
    let path = PathBuf::from(&dir_path);
    if !path.exists() {
        return Err("Directory does not exist".to_string());
    }

    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();

    let walker = WalkBuilder::new(&path)
        .hidden(true)
        .build()
        .filter_map(|e| e.ok());

    for entry in walker {
        if entry.path().is_file() {
            if let Some(ext) = entry.path().extension() {
                if ext == "md" || ext == "markdown" {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        for (line_num, line) in content.lines().enumerate() {
                            if line.to_lowercase().contains(&query_lower) {
                                results.push(SearchResult {
                                    path: entry.path().to_string_lossy().to_string(),
                                    title: extract_title(&content, entry.path().to_string_lossy().as_ref()),
                                    line_number: line_num + 1,
                                    line_content: line.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
fn get_backlinks(dir_path: String, target_title: String) -> Result<Vec<FileEntry>, String> {
    let index = scan_directory(dir_path)?;
    let mut backlinks: Vec<FileEntry> = Vec::new();

    for link in index.backlinks {
        if link.target.to_lowercase() == target_title.to_lowercase() {
            if let Some(file) = index.files.iter().find(|f| f.path == link.source) {
                backlinks.push(file.clone());
            }
        }
    }

    Ok(backlinks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            get_file_content,
            search_content,
            get_backlinks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
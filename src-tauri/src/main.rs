#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct Pending(Mutex<Option<String>>);
#[derive(serde::Serialize)]
struct Document {
    path: String,
    content: String,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown"))
}

#[tauri::command]
fn read_document(app: tauri::AppHandle, path: String) -> Result<Document, String> {
    let path = fs::canonicalize(&path).map_err(|e| format!("파일을 찾을 수 없습니다: {e}"))?;
    if !is_markdown(&path) {
        return Err("Markdown 파일(.md, .markdown, .mdown)을 선택하세요.".into());
    }
    let file = fs::File::open(&path).map_err(|e| format!("파일을 열 수 없습니다: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("일반 파일만 열 수 있습니다.".into());
    }
    let mut bytes = Vec::new();
    file.take(10 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("10MB 이하의 문서를 선택하세요.".into());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "UTF-8로 저장된 Markdown 파일이 필요합니다.")?;
    // Only the opened document's folder is exposed for local images.
    if let Some(parent) = path.parent() {
        app.asset_protocol_scope()
            .allow_directory(parent, true)
            .map_err(|e| e.to_string())?;
    }
    Ok(Document {
        path: path.to_string_lossy().into_owned(),
        content: content.trim_start_matches('\u{feff}').to_owned(),
    })
}

#[tauri::command]
fn take_pending(state: tauri::State<Pending>) -> Option<String> {
    state.0.lock().unwrap().take()
}

fn queue_file(app: &tauri::AppHandle, path: PathBuf) {
    if !is_markdown(&path) {
        return;
    }
    *app.state::<Pending>().0.lock().unwrap() = Some(path.to_string_lossy().into_owned());
    let _ = app.emit("open-document", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Pending::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(arg) = args.iter().skip(1).find(|arg| is_markdown(Path::new(arg))) {
                queue_file(app, Path::new(&cwd).join(arg));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_document, take_pending])
        .setup(|app| {
            if let Some(path) = std::env::args_os()
                .skip(1)
                .map(PathBuf::from)
                .find(|p| is_markdown(p))
            {
                queue_file(app.handle(), path);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("MDV를 시작하지 못했습니다.");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            if let Some(path) = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .find(|p| is_markdown(p))
            {
                queue_file(_app, path);
            }
        }
    });
}

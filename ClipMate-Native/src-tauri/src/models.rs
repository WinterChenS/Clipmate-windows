use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, RunEvent, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, WindowEvent,
};

// ─── 数据模型 ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClipContent {
    #[serde(rename = "text")]
    Text { content: String },
    #[serde(rename = "image")]
    Image { path: String, preview: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipItem {
    pub id: i64,
    pub content: ClipContent,
    pub time: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub layout: String,            // "bottom" | "right"
    pub max_items: usize,          // 200
    pub show_status_bar: bool,
    pub theme: String,             // "dark" | "light"
    pub auto_start: bool,
    pub toggle_shortcut: String,   // "Ctrl+Shift+V"
    pub settings_shortcut: String, // "Ctrl+Shift+S"
    pub skip_update_version: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            layout: "bottom".into(),
            max_items: 200,
            show_status_bar: true,
            theme: "dark".into(),
            auto_start: false,
            toggle_shortcut: "Ctrl+Shift+V".into(),
            settings_shortcut: "Ctrl+Shift+S".into(),
            skip_update_version: None,
        }
    }
}

pub struct AppState {
    pub history: Mutex<Vec<ClipItem>>,
    pub settings: Mutex<AppSettings>,
    pub last_clipboard_text: Mutex<String>,
    pub last_clipboard_image_hash: Mutex<String>,
    pub visible: Mutex<bool>,
    pub next_id: Mutex<i64>,
}

// ─── 数据目录 ──────────────────────────────────────────────────

pub fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("clipmate");
    fs::create_dir_all(&dir).ok();
    dir
}

pub fn images_dir() -> PathBuf {
    let dir = data_dir().join("images");
    fs::create_dir_all(&dir).ok();
    dir
}

pub fn history_path() -> PathBuf {
    data_dir().join("clipboard-history.json")
}

pub fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn log_path() -> PathBuf {
    data_dir().join("debug.log")
}

// ─── 日志 ──────────────────────────────────────────────────────

pub fn log_msg(msg: &str) {
    let path = log_path();
    let timestamp = chrono::Local::now().format("%H:%M:%S");
    let line = format!("[{}] {}\n", timestamp, msg);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

// ─── 历史读写 ──────────────────────────────────────────────────

pub fn load_history() -> Vec<ClipItem> {
    let path = history_path();
    if !path.exists() {
        return Vec::new();
    }
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save_history(items: &[ClipItem]) {
    let path = history_path();
    if let Ok(s) = serde_json::to_string_pretty(items) {
        let _ = fs::write(&path, s);
    }
}

// ─── 设置读写 ──────────────────────────────────────────────────

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    if !path.exists() {
        return AppSettings::default();
    }
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(s: &AppSettings) {
    let path = settings_path();
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = fs::write(&path, json);
    }
}

// ─── 图片保存 ──────────────────────────────────────────────────

pub fn save_clipboard_image(data: &[u8], item_id: i64) -> Option<String> {
    let dir = images_dir();
    let file_path = dir.join(format!("{}.png", item_id));
    fs::write(&file_path, data).ok()?;
    log_msg(&format!("图片已保存: {}.png ({}KB)", item_id, data.len() / 1024));
    Some(file_path.to_string_lossy().to_string())
}

pub fn compute_image_hash(data: &[u8]) -> String {
    use md5::Digest;
    let mut hasher = md5::Md5::new();
    // 只取前 4KB + 长度做指纹，加速去重
    let chunk = if data.len() > 4096 { &data[..4096] } else { data };
    hasher.update(chunk);
    hasher.update(format!("{}", data.len()).as_bytes());
    format!("{:x}", hasher.finalize())
}

// ─── 清理过期图片 ──────────────────────────────────────────────

pub fn cleanup_old_images(keep_ids: &[i64]) {
    let dir = images_dir();
    let keep_names: std::collections::HashSet<String> =
        keep_ids.iter().map(|id| format!("{}.png", id)).collect();

    if let Ok(entries) = fs::read_dir(&dir) {
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".png") && !keep_names.contains(&name) {
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            log_msg(&format!("清理孤儿图片: {} 个", removed));
        }
    }

    // 清理超过 7 天的图片
    let max_age = chrono::Local::now() - chrono::Duration::days(7);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let modified_time: chrono::DateTime<chrono::Local> = modified.into();
                    if modified_time < max_age {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

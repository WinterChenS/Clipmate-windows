use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

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
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub layout: String,            // "bottom" | "right"
    #[serde(alias = "max_items")]
    pub max_items: usize,          // 200
    #[serde(alias = "show_status_bar")]
    pub show_status_bar: bool,
    pub theme: String,             // "dark" | "light"
    #[serde(alias = "auto_start")]
    pub auto_start: bool,
    #[serde(alias = "toggle_shortcut")]
    pub toggle_shortcut: String,   // "Ctrl+Shift+V"
    #[serde(alias = "settings_shortcut")]
    pub settings_shortcut: String, // "Ctrl+Shift+S"
    #[serde(alias = "skip_update_version")]
    pub skip_update_version: Option<String>,
    #[serde(alias = "max_storage_mb")]
    pub max_storage_mb: u64,       // 最大存储容量 (MB)
    #[serde(default)]
    pub version: Option<String>,   // 记录版本号
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
            max_storage_mb: 200,
            version: None,
        }
    }
}

#[allow(dead_code)]
pub struct AppState {
    pub history: Mutex<Vec<ClipItem>>,
    pub settings: Mutex<AppSettings>,
    pub last_clipboard_text: Mutex<String>,
    pub last_clipboard_image_hash: Mutex<String>,
    pub visible: Mutex<bool>,
    pub next_id: Mutex<i64>,
    pub last_shown: Mutex<std::time::Instant>,
    pub autostart_menu_text: Mutex<String>, // 托盘"开机启动"菜单文字（跨模块共享）
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

const MAX_LOG_SIZE: u64 = 512 * 1024; // 512KB

pub fn log_msg(msg: &str) {
    let path = log_path();

    // 日志轮转：超限时截断
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_LOG_SIZE {
            // 保留最后 256KB，需要对齐到 UTF-8 字符边界
            if let Ok(content) = fs::read_to_string(&path) {
                let keep = content.len().saturating_sub(256 * 1024);
                // 找到下一个有效的 UTF-8 字符边界，避免切在中文中间
                let mut boundary = keep;
                while boundary < content.len() && !content.is_char_boundary(boundary) {
                    boundary += 1;
                }
                let truncated = &content[boundary..];
                let _ = fs::write(&path, truncated);
            }
        }
    }

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

// ─── 图片保存与缩略图 ──────────────────────────────────────────

/// 缩略图最大宽度
const THUMB_MAX_WIDTH: u32 = 200;

#[allow(dead_code)]
pub fn save_clipboard_image(data: &[u8], item_id: i64) -> Option<String> {
    let dir = images_dir();
    let file_path = dir.join(format!("{}.png", item_id));
    fs::write(&file_path, data).ok()?;
    log_msg(&format!("图片已保存: {}.png ({}KB)", item_id, data.len() / 1024));

    // 同时生成缩略图
    generate_and_save_thumbnail(data, item_id);

    Some(file_path.to_string_lossy().to_string())
}

/// 从已保存的图片文件生成缩略图
pub fn generate_and_save_thumbnail(image_data: &[u8], item_id: i64) {
    let dir = images_dir();
    let thumb_path = dir.join(format!("thumb_{}.png", item_id));

    match image::load_from_memory(image_data) {
        Ok(img) => {
            // 按比例缩放
            let (w, h) = (img.width(), img.height());
            let thumb_img = if w > THUMB_MAX_WIDTH {
                let ratio = THUMB_MAX_WIDTH as f32 / w as f32;
                let thumb_h = (h as f32 * ratio) as u32;
                img.resize(THUMB_MAX_WIDTH, thumb_h, image::imageops::FilterType::Triangle)
            } else {
                // 小图不需要缩放，直接保存原图作为缩略图
                img
            };

            let mut buf = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buf);
            if let Err(e) = thumb_img.write_to(&mut cursor, image::ImageFormat::Png) {
                log_msg(&format!("缩略图编码失败: {}", e));
                return;
            }

            if let Err(e) = fs::write(&thumb_path, &buf) {
                log_msg(&format!("缩略图写入失败: {}", e));
            } else {
                log_msg(&format!("缩略图已保存: thumb_{}.png ({}KB)", item_id, buf.len() / 1024));
            }
        }
        Err(e) => {
            log_msg(&format!("缩略图生成失败 (解码): {}", e));
        }
    }
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

/// 全面清理：孤儿图片 + 7天过期 + 存储容量限制
pub fn cleanup_old_images(keep_ids: &[i64], max_storage_mb: u64) {
    let dir = images_dir();

    // 1. 清理孤儿图片（不在 keep_ids 中的）和对应缩略图
    let keep_names: std::collections::HashSet<String> =
        keep_ids.iter().flat_map(|id| {
            let base = id.to_string();
            [format!("{}.png", base), format!("thumb_{}.png", base)]
        }).collect();

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

    // 2. 清理超过 7 天的图片（包括缩略图）
    let max_age = chrono::Local::now() - chrono::Duration::days(7);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let modified_time: chrono::DateTime<chrono::Local> = modified.into();
                    if modified_time < max_age {
                        let name = entry.file_name().to_string_lossy().to_string();
                        // 同时删除原图和缩略图
                        let _ = fs::remove_file(entry.path());
                        if name.starts_with("thumb_") {
                            let id_str = name.trim_start_matches("thumb_").trim_end_matches(".png");
                            let orig = dir.join(format!("{}.png", id_str));
                            let _ = fs::remove_file(&orig);
                        } else if !name.starts_with("thumb_") {
                            let id_str = name.trim_end_matches(".png");
                            let thumb = dir.join(format!("thumb_{}.png", id_str));
                            let _ = fs::remove_file(&thumb);
                        }
                    }
                }
            }
        }
    }

    // 3. 总大小超限时，从最旧的开始删除
    cleanup_oversized_images(max_storage_mb);
}

/// 检查图片总大小，超限时从最旧的开始删除
fn cleanup_oversized_images(max_storage_mb: u64) {
    if max_storage_mb == 0 {
        return; // 0 = 无限制
    }

    let dir = images_dir();

    // 收集所有原图文件信息（缩略图不计入配额，它们很小）
    let mut files: Vec<(String, std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".png") || name.starts_with("thumb_") { continue; }
            if let Ok(meta) = entry.metadata() {
                let size = meta.len();
                let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((name, entry.path(), size, mtime));
            }
        }
    }

    // 计算总大小（原图）
    let total_size: u64 = files.iter().map(|f| f.2).sum();
    let max_size_bytes = max_storage_mb * 1024 * 1024;

    if total_size <= max_size_bytes {
        return; // 未超限
    }

    // 按修改时间排序（旧的在前）
    files.sort_by(|a, b| a.3.cmp(&b.3));

    let mut current_size = total_size;
    let mut removed = 0;
    for (name, path, size, _) in files {
        if current_size <= max_size_bytes { break; }
        // 同时删除原图和缩略图
        let id_str = name.trim_end_matches(".png");
        let thumb_path = dir.join(format!("thumb_{}.png", id_str));
        let _ = fs::remove_file(&thumb_path); // 删缩略图（可能不存在，无所谓）
        if fs::remove_file(&path).is_ok() {
            current_size -= size;
            removed += 1;
            log_msg(&format!("清理超容图片: {} ({}KB)", name, size / 1024));
        }
    }

    if removed > 0 {
        log_msg(&format!("图片清理完成，删除 {} 个，剩余 {:.1}MB", removed, current_size as f64 / 1024.0 / 1024.0));
    }
}

/// 获取图片目录总大小（仅原图，不含缩略图）
pub fn get_images_total_size() -> u64 {
    let dir = images_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        entries.flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.ends_with(".png") && !name.starts_with("thumb_")
            })
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    } else {
        0
    }
}

/// 获取Windows工作区（排除任务栏）
#[cfg(target_os = "windows")]
pub fn get_work_area() -> (i32, i32, i32, i32) {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::Foundation::{HWND, RECT};

    unsafe {
        // 方式1：先尝试用 SPI_GETWORKAREA（最可靠）
        {
            use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut rect as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok() {
                return (rect.left, rect.top, rect.right, rect.bottom);
            }
        }

        // 方式2：回退到 GetMonitorInfoW
        let hmonitor = MonitorFromWindow(HWND(std::ptr::null_mut()), MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            rcMonitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
            rcWork: RECT { left: 0, top: 0, right: 0, bottom: 0 },
            dwFlags: 0,
        };
        if GetMonitorInfoW(hmonitor, &mut mi).as_bool() {
            (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
        } else {
            (0, 0, 1920, 1080)
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_work_area() -> (i32, i32, i32, i32) {
    (0, 0, 1920, 1080)
}

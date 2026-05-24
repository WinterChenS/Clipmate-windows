use std::fs;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::models::*;

// ─── 剪贴板监听命令 ────────────────────────────────────────────

#[tauri::command]
pub fn get_history(state: State<'_, AppState>) -> Vec<ClipItem> {
    let history = state.history.lock().unwrap();
    history.clone()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    let mut settings = state.settings.lock().unwrap().clone();
    // 始终用编译时版本号填充（Cargo.toml 中的 version）
    let compile_version = env!("CARGO_PKG_VERSION").to_string();
    settings.version = Some(compile_version);
    settings
}

#[tauri::command]
pub fn save_settings_cmd(new_settings: AppSettings, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // 检测快捷键变化
    let old_shortcut = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.toggle_shortcut.clone()
    };

    let shortcut_changed = old_shortcut != new_settings.toggle_shortcut;

    // 保存新设置
    let max_items = new_settings.max_items;
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        *settings = new_settings.clone();
    }
    save_settings(&new_settings);

    // max_items 变小时裁剪历史
    {
        let mut history = state.history.lock().map_err(|e| e.to_string())?;
        if history.len() > max_items {
            let mut to_remove = history.len() - max_items;
            while to_remove > 0 {
                if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                    history.remove(pos);
                    to_remove -= 1;
                } else {
                    break;
                }
            }
            save_history(&history);
            log_msg(&format!("设置变更裁剪: 历史裁剪到 {} 条", history.len()));
            // 通知前端刷新
            let _ = app.emit("history-updated", ());
        }
    }

    // 快捷键变化时重新注册
    if shortcut_changed {
        let gs = app.global_shortcut();
        let _ = gs.unregister(old_shortcut.as_str());
        log_msg(&format!("已注销旧快捷键: {}", old_shortcut));

        let new_shortcut = new_settings.toggle_shortcut.clone();
        if let Err(e) = gs.on_shortcut(new_shortcut.as_str(), move |app, _shortcut, event| {
            use tauri_plugin_global_shortcut::ShortcutState;
            if event.state != ShortcutState::Pressed { return; }
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                else {
                    let _ = window.show();
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.set_focus();
                    let _ = window.emit("window-shown", ());
                    let state = app.state::<AppState>();
                    *state.last_shown.lock().unwrap() = std::time::Instant::now();
                }
            }
        }) {
            log_msg(&format!("新快捷键注册失败: {}, 回退默认", e));
            let _ = gs.on_shortcut("Ctrl+Shift+V", move |app, _shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;
                if event.state != ShortcutState::Pressed { return; }
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                    else {
                        let _ = window.show();
                        let _ = window.set_skip_taskbar(true);
                        let _ = window.set_focus();
                        let _ = window.emit("window-shown", ());
                        let state = app.state::<AppState>();
                        *state.last_shown.lock().unwrap() = std::time::Instant::now();
                    }
                }
            });
        } else {
            log_msg(&format!("新快捷键已注册: {}", new_shortcut));
        }
    }

    // 布局变化时重新定位窗口
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let state_inner = app.state::<AppState>();
            let s = state_inner.settings.lock().unwrap();
            let (work_left, work_top, work_right, work_bottom) = crate::models::get_work_area();
            let work_w = work_right - work_left;
            let work_h = work_bottom - work_top;
            let is_right = s.layout == "right";
            let (w, h, x, y) = if is_right {
                (360, work_h, work_right - 360, work_top)
            } else {
                (work_w, 280, work_left, work_bottom - 280)
            };
            let _ = window.set_size(tauri::LogicalSize::new(w as f64, h as f64));
            let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
        }
    }

    // 更新 autolaunch 状态 + 托盘菜单文字
    {
        let label = if new_settings.auto_start { "开机启动 ✓" } else { "开机启动" };
        // 更新 AppState 中的菜单文字
        if let Ok(mut text) = state.autostart_menu_text.lock() {
            *text = label.to_string();
        }
        // 更新 autolaunch
        {
            use tauri_plugin_autostart::ManagerExt;
            let manager = app.autolaunch();
            if new_settings.auto_start {
                let _ = manager.enable();
            } else {
                let _ = manager.disable();
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn delete_item(item_id: i64, state: State<'_, AppState>) -> Result<Vec<ClipItem>, String> {
    let mut history = state.history.lock().map_err(|e| e.to_string())?;

    // 找到要删除的项，如果是图片则删除对应的文件和缩略图
    if let Some(item) = history.iter().find(|i| i.id == item_id) {
        if let ClipContent::Image { .. } = &item.content {
            let img_path = images_dir().join(format!("{}.png", item_id));
            let thumb_path = images_dir().join(format!("thumb_{}.png", item_id));
            if img_path.exists() {
                let _ = fs::remove_file(&img_path);
                log_msg(&format!("删除图片文件: {}.png", item_id));
            }
            if thumb_path.exists() {
                let _ = fs::remove_file(&thumb_path);
                log_msg(&format!("删除缩略图: thumb_{}.png", item_id));
            }
        }
    }

    history.retain(|item| item.id != item_id);
    save_history(&history);
    Ok(history.clone())
}

#[tauri::command]
pub fn pin_item(item_id: i64, state: State<'_, AppState>) -> Result<Vec<ClipItem>, String> {
    let mut history = state.history.lock().map_err(|e| e.to_string())?;
    if let Some(item) = history.iter_mut().find(|i| i.id == item_id) {
        item.pinned = !item.pinned;
    }
    save_history(&history);
    Ok(history.clone())
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<Vec<ClipItem>, String> {
    let mut history = state.history.lock().map_err(|e| e.to_string())?;
    let max_storage_mb = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.max_storage_mb
    };
    // 保留 pinned 的项目
    history.retain(|item| item.pinned);
    // 清理孤儿图片
    let keep_ids: Vec<i64> = history.iter().map(|i| i.id).collect();
    cleanup_old_images(&keep_ids, max_storage_mb);
    save_history(&history);
    Ok(history.clone())
}

#[tauri::command]
pub fn paste_item(item_id: i64, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let history = state.history.lock().map_err(|e| e.to_string())?;
    let item = history.iter().find(|i| i.id == item_id)
        .ok_or("Item not found")?
        .clone();
    drop(history);

    match &item.content {
        ClipContent::Text { content } => {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(content.clone()).map_err(|e| e.to_string())?;
        }
        ClipContent::Image { path, .. } => {
            // path 可能是 file:/// URL 或普通路径，统一处理
            let file_path = if path.starts_with("file:///") {
                path.trim_start_matches("file:///").replace('/', "\\")
            } else {
                path.replace('\\', "/")
            };
            let data = fs::read(&file_path).map_err(|e| format!("读取图片失败: {} (path={})", e, file_path))?;
            // 解码 PNG 为 RGBA 像素数据
            let img = image::load_from_memory(&data).map_err(|e| format!("解码图片失败: {}", e))?;
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let img_data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: rgba.into_raw().into(),
            };
            clipboard.set_image(img_data).map_err(|e| e.to_string())?;
        }
    }

    // 先隐藏窗口，再模拟粘贴（隐藏后焦点回到上一个应用，Ctrl+V 才能正确粘贴）
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // 延迟模拟 Ctrl+V，等待焦点切换完成
    std::thread::sleep(std::time::Duration::from_millis(100));
    simulate_paste();
    Ok(())
}

#[tauri::command]
pub fn copy_item(item_id: i64, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let history = state.history.lock().map_err(|e| e.to_string())?;
    let item = history.iter().find(|i| i.id == item_id)
        .ok_or("Item not found")?
        .clone();
    drop(history);

    match &item.content {
        ClipContent::Text { content } => {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(content.clone()).map_err(|e| e.to_string())?;
        }
        ClipContent::Image { path, .. } => {
            let file_path = if path.starts_with("file:///") {
                path.trim_start_matches("file:///").replace('/', "\\")
            } else {
                path.replace('\\', "/")
            };
            let data = fs::read(&file_path).map_err(|e| format!("读取图片失败: {} (path={})", e, file_path))?;
            let img = image::load_from_memory(&data).map_err(|e| format!("解码图片失败: {}", e))?;
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let img_data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: rgba.into_raw().into(),
            };
            clipboard.set_image(img_data).map_err(|e| e.to_string())?;
        }
    }

    // 复制后自动隐藏窗口
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    Ok(())
}

#[tauri::command]
pub fn get_image_data_url(item_id: i64) -> Result<String, String> {
    let dir = images_dir();
    let path = dir.join(format!("{}.png", item_id));
    if !path.exists() {
        return Err(format!("图片 {} 不存在", item_id));
    }
    let data = fs::read(&path).map_err(|e| format!("读取图片失败: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{}", b64))
}

/// 获取缩略图 data URL（用于卡片显示，大幅减少内存占用）
#[tauri::command]
pub fn get_thumbnail_data_url(item_id: i64) -> Result<String, String> {
    let dir = images_dir();
    // 优先读缩略图，不存在则 fallback 到原图
    let thumb_path = dir.join(format!("thumb_{}.png", item_id));
    let (path, is_thumb) = if thumb_path.exists() {
        (thumb_path, true)
    } else {
        let orig_path = dir.join(format!("{}.png", item_id));
        if orig_path.exists() {
            (orig_path, false)
        } else {
            return Err(format!("图片 {} 不存在", item_id));
        }
    };

    let data = fs::read(&path).map_err(|e| format!("读取{}失败: {}", if is_thumb { "缩略图" } else { "图片" }, e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{}", b64))
}

/// 获取存储信息（图片总大小、图片数量）
#[tauri::command]
pub fn get_storage_info() -> StorageInfo {
    let dir = images_dir();
    let mut total_size: u64 = 0;
    let mut image_count: u64 = 0;

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".png") && !name.starts_with("thumb_") {
                if let Ok(meta) = entry.metadata() {
                    total_size += meta.len();
                    image_count += 1;
                }
            }
        }
    }

    StorageInfo {
        total_size_mb: (total_size as f64 / 1024.0 / 1024.0 * 10.0).round() / 10.0,
        image_count,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageInfo {
    pub total_size_mb: f64,
    pub image_count: u64,
}

#[tauri::command]
pub fn get_image_url(item_id: i64) -> String {
    let dir = images_dir();
    let path = dir.join(format!("{}.png", item_id));
    if path.exists() {
        format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
    } else {
        String::new()
    }
}

#[tauri::command]
pub fn toggle_window(app: AppHandle, state: State<'_, AppState>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_skip_taskbar(true);
            let _ = window.set_focus();
            let _ = window.emit("window-shown", ());
            *state.last_shown.lock().unwrap() = std::time::Instant::now();
        }
    }
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn show_window(app: AppHandle, state: State<'_, AppState>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_skip_taskbar(true);
        let _ = window.set_focus();
        let _ = window.emit("window-shown", ());
        *state.last_shown.lock().unwrap() = std::time::Instant::now();
    }
}

#[tauri::command]
pub fn set_autostart(enable: bool, app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enable {
        manager.enable().map_err(|e| e.to_string())?;
        log_msg("开机自启动已启用（设置面板）");
    } else {
        manager.disable().map_err(|e| e.to_string())?;
        log_msg("开机自启动已关闭（设置面板）");
    }
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.auto_start = enable;
        save_settings(&settings);
    }
    // 同步更新托盘菜单文字
    {
        let label = if enable { "开机启动 ✓" } else { "开机启动" };
        if let Ok(mut text) = state.autostart_menu_text.lock() {
            *text = label.to_string();
        }
    }
    // 通知前端和托盘菜单监听器刷新
    let _ = app.emit("settings-updated", ());
    Ok(enable)
}

// ─── 版本检查 ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub download_url: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_for_update() -> UpdateCheckResult {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return UpdateCheckResult {
                available: false,
                current_version: current,
                latest_version: None,
                download_url: None,
                error: Some(format!("网络错误: {}", e)),
            };
        }
    };

    let resp = client
        .get("https://api.github.com/repos/WinterChenS/Clipmate-windows/tags?per_page=10")
        .header("User-Agent", "ClipMate-UpdateCheck")
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            match res.json::<Vec<serde_json::Value>>().await {
                Ok(tags) => {
                    let latest_tag = tags
                        .iter()
                        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
                        .filter(|n| regex_lite::Regex::new(r"^v?\d+\.\d+\.\d+$").map(|r| r.is_match(n)).unwrap_or(false))
                        .max_by(|a, b| compare_semver(a, b));

                    match latest_tag {
                        Some(tag) => {
                            let latest_version = tag.trim_start_matches('v').to_string();
                            let has_update = compare_semver(&format!("v{}", current), tag) == std::cmp::Ordering::Less;
                            UpdateCheckResult {
                                available: has_update,
                                current_version: current,
                                latest_version: Some(latest_version.clone()),
                                download_url: if has_update {
                                    Some(format!("https://github.com/WinterChenS/Clipmate-windows/releases/tag/{}", tag))
                                } else {
                                    None
                                },
                                error: None,
                            }
                        }
                        None => UpdateCheckResult {
                            available: false,
                            current_version: current,
                            latest_version: None,
                            download_url: None,
                            error: Some("无 tag 数据".into()),
                        },
                    }
                }
                Err(e) => UpdateCheckResult {
                    available: false,
                    current_version: current,
                    latest_version: None,
                    download_url: None,
                    error: Some(format!("解析失败: {}", e)),
                },
            }
        }
        Ok(res) => UpdateCheckResult {
            available: false,
            current_version: current,
            latest_version: None,
            download_url: None,
            error: Some(format!("HTTP {}", res.status())),
        },
        Err(e) => UpdateCheckResult {
            available: false,
            current_version: current,
            latest_version: None,
            download_url: None,
            error: Some(format!("网络连接失败: {}", e)),
        },
    }
}

#[tauri::command]
pub fn skip_update_version(version: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.skip_update_version = Some(version);
    save_settings(&settings);
    Ok(())
}

// ─── 工具函数 ──────────────────────────────────────────────────

fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u32> = a.trim_start_matches('v')
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    let pb: Vec<u32> = b.trim_start_matches('v')
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    for i in 0..3 {
        let va = pa.get(i).unwrap_or(&0);
        let vb = pb.get(i).unwrap_or(&0);
        match va.cmp(vb) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn simulate_paste() {
    // 使用 Windows API 模拟 Ctrl+V
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_TYPE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_V,
        };

        let key_down_flags = KEYBD_EVENT_FLAGS(0);
        let key_up_flags = KEYEVENTF_KEYUP;

        let inputs: [INPUT; 4] = [
            INPUT {
                r#type: INPUT_TYPE(1), // INPUT_KEYBOARD
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(VK_CONTROL.0 as u16),
                        wScan: 0,
                        dwFlags: key_down_flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_TYPE(1),
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(VK_V.0 as u16),
                        wScan: 0,
                        dwFlags: key_down_flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_TYPE(1),
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(VK_V.0 as u16),
                        wScan: 0,
                        dwFlags: key_up_flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_TYPE(1),
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(VK_CONTROL.0 as u16),
                        wScan: 0,
                        dwFlags: key_up_flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::models::*;

// ─── 剪贴板监听命令 ────────────────────────────────────────────

#[tauri::command]
pub fn get_history(state: State<'_, AppState>) -> Vec<ClipItem> {
    let history = state.history.lock().unwrap();
    history.clone()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    let settings = state.settings.lock().unwrap();
    settings.clone()
}

#[tauri::command]
pub fn save_settings_cmd(new_settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    *settings = new_settings.clone();
    save_settings(&new_settings);
    Ok(())
}

#[tauri::command]
pub fn delete_item(item_id: i64, state: State<'_, AppState>) -> Result<Vec<ClipItem>, String> {
    let mut history = state.history.lock().map_err(|e| e.to_string())?;
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
    // 保留 pinned 的项目
    history.retain(|item| item.pinned);
    // 清理孤儿图片
    let keep_ids: Vec<i64> = history.iter().map(|i| i.id).collect();
    cleanup_old_images(&keep_ids);
    save_history(&history);
    Ok(history.clone())
}

#[tauri::command]
pub fn paste_item(item_id: i64, state: State<'_, AppState>) -> Result<(), String> {
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
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let img = arboard::ImageData {
                width: 0, // arboard 会自动检测
                height: 0,
                bytes: data.into(),
            };
            clipboard.set_image(img).map_err(|e| e.to_string())?;
        }
    }

    // 模拟 Ctrl+V 粘贴
    simulate_paste();
    Ok(())
}

#[tauri::command]
pub fn copy_item(item_id: i64, state: State<'_, AppState>) -> Result<(), String> {
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
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let img = arboard::ImageData {
                width: 0,
                height: 0,
                bytes: data.into(),
            };
            clipboard.set_image(img).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
pub fn toggle_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
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
pub fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
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

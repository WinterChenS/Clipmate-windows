// 隐藏 Windows 控制台窗口（release 模式）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, RunEvent,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

mod models;
mod commands;

use models::*;

fn main() {
    // 设置 panic hook：release 模式 panic = abort 不会打印信息，hook 可以写入日志
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let location = if let Some(loc) = info.location() {
            format!("{}:{}", loc.file(), loc.line())
        } else {
            "unknown location".to_string()
        };
        let full = format!("PANIC at {} - {}", location, msg);
        // 直接写入文件，不依赖可能已损坏的状态
        let path = log_path();
        let timestamp = chrono::Local::now().format("%H:%M:%S");
        let line = format!("[{}] {}\n", timestamp, full);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }));

    log_msg("=== ClipMate (Tauri 2.0) 启动 ===");

    // 加载数据
    let mut history = load_history();
    let settings = load_settings();
    let next_id = history.iter().map(|i| i.id).max().unwrap_or(0) + 1;

    // 启动时按 max_items 裁剪历史（避免已有条数超过设置上限）
    let max = settings.max_items;
    if history.len() > max {
        let removed = history.len() - max;
        // 从末尾移除非固定条目
        let mut to_remove = removed;
        while to_remove > 0 {
            if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                history.remove(pos);
                to_remove -= 1;
            } else {
                break;
            }
        }
        log_msg(&format!("启动裁剪: 移除 {} 条多余历史（上限 {}）", removed - to_remove, max));
        save_history(&history);
    }

    log_msg(&format!("加载历史: {} 条, 布局: {}", history.len(), settings.layout));

    let auto_start_label = if settings.auto_start { "开机启动 ✓" } else { "开机启动" };
    let settings_clone = settings.clone();

    let state = AppState {
        history: Mutex::new(history),
        settings: Mutex::new(settings),
        last_clipboard_text: Mutex::new(String::new()),
        last_clipboard_image_hash: Mutex::new(String::new()),
        visible: Mutex::new(false),
        next_id: Mutex::new(next_id),
        last_shown: Mutex::new(std::time::Instant::now() - Duration::from_secs(10)),
        autostart_menu_text: Mutex::new(auto_start_label.to_string()),
    };

    log_msg("构建 Tauri 应用...");

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_msg("第二个实例启动，聚焦已有窗口");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_skip_taskbar(true);
                let _ = window.set_focus();
                let _ = window.emit("window-shown", ());
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut last_shown) = state.last_shown.lock() {
                        *last_shown = std::time::Instant::now();
                    }
                }
            }
        }))
        .manage(state)
        .setup(move |app| {
            log_msg("setup 回调开始");

            // 托盘菜单（安全处理，失败不 panic）
            let show_item = match MenuItemBuilder::with_id("show", "显示 ClipMate").build(app) {
                Ok(item) => item,
                Err(e) => {
                    log_msg(&format!("托盘菜单项创建失败: {}", e));
                    return Ok(());
                }
            };
            let autostart_item = match MenuItemBuilder::with_id("autostart", auto_start_label).build(app) {
                Ok(item) => item,
                Err(e) => {
                    log_msg(&format!("托盘菜单项创建失败: {}", e));
                    return Ok(());
                }
            };
            let quit_item = match MenuItemBuilder::with_id("quit", "退出").build(app) {
                Ok(item) => item,
                Err(e) => {
                    log_msg(&format!("托盘菜单项创建失败: {}", e));
                    return Ok(());
                }
            };

            let menu = match MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&autostart_item)
                .separator()
                .item(&quit_item)
                .build()
            {
                Ok(m) => m,
                Err(e) => {
                    log_msg(&format!("托盘菜单创建失败: {}", e));
                    return Ok(());
                }
            };

            log_msg("托盘菜单创建成功");

            // 提前 clone autostart_item 供后续 settings-updated 监听使用
            let autostart_item_for_listener = autostart_item.clone();

            // 托盘图标：安全加载，失败则跳过托盘
            let icon_result = app.default_window_icon().cloned();
            if let Some(icon) = icon_result {
                match TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .menu(&menu)
                    .tooltip(&format!("ClipMate v{}", env!("CARGO_PKG_VERSION")))
                    .on_menu_event(move |app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_skip_taskbar(true);
                                    let _ = window.set_focus();
                                    let _ = window.emit("window-shown", ());
                                    if let Some(state) = app.try_state::<AppState>() {
                                        if let Ok(mut last_shown) = state.last_shown.lock() {
                                            *last_shown = std::time::Instant::now();
                                        }
                                    }
                                }
                            }
                            "autostart" => {
                                if let Some(state) = app.try_state::<AppState>() {
                                    if let Ok(mut settings) = state.settings.lock() {
                                        settings.auto_start = !settings.auto_start;
                                        let enable = settings.auto_start;
                                        save_settings(&settings);
                                        // 更新托盘菜单文字
                                        let label = if enable { "开机启动 ✓" } else { "开机启动" };
                                        let _ = autostart_item.set_text(label);
                                        if let Ok(mut text) = state.autostart_menu_text.lock() {
                                            *text = label.to_string();
                                        }
                                        {
                                            use tauri_plugin_autostart::ManagerExt;
                                            let manager = app.autolaunch();
                                            if enable {
                                                match manager.enable() {
                                                    Ok(_) => log_msg("开机自启动已启用"),
                                                    Err(e) => log_msg(&format!("开机自启动启用失败: {}", e)),
                                                }
                                            } else {
                                                match manager.disable() {
                                                    Ok(_) => log_msg("开机自启动已关闭"),
                                                    Err(e) => log_msg(&format!("开机自启动关闭失败: {}", e)),
                                                }
                                            }
                                        }
                                    }
                                }
                                // 通知前端设置已变更
                                let _ = app.emit("settings-updated", ());
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .build(app)
                {
                    Ok(_) => log_msg("托盘图标创建成功"),
                    Err(e) => log_msg(&format!("托盘图标创建失败: {}", e)),
                }
            } else {
                log_msg("警告: 默认窗口图标加载失败，跳过托盘");
            }

            let app_handle = app.handle().clone();

            // 设置窗口位置
            if let Some(window) = app.get_webview_window("main") {
                log_msg("窗口已获取，设置位置...");
                position_window(&window, &app_handle);

                // 确保窗口不出现在任务栏（只显示托盘图标）
                let _ = window.set_skip_taskbar(true);

                // 初始显示时触发入场动画
                let _ = window.emit("window-shown", ());

                // 窗口失焦隐藏（带保护期）
                let app_h = app_handle.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Focused(false) => {
                            let app_h = app_h.clone();
                            std::thread::spawn(move || {
                                // 检查保护期
                                if let Some(state) = app_h.try_state::<AppState>() {
                                    if let Ok(last_shown) = state.last_shown.lock() {
                                        if last_shown.elapsed() < Duration::from_millis(500) {
                                            return;
                                        }
                                    }
                                }

                                std::thread::sleep(Duration::from_millis(200));
                                if let Some(w) = app_h.get_webview_window("main") {
                                    // 再次检查保护期
                                    if let Some(state) = app_h.try_state::<AppState>() {
                                        if let Ok(last_shown) = state.last_shown.lock() {
                                            if last_shown.elapsed() < Duration::from_millis(500) {
                                                return;
                                            }
                                        }
                                    }
                                    if !w.is_focused().unwrap_or(false) {
                                        log_msg("窗口失焦，自动隐藏");
                                        let _ = w.hide();
                                    }
                                }
                            });
                        }
                        WindowEvent::Destroyed => {
                            log_msg("窗口已销毁");
                        }
                        _ => {}
                    }
                });
            } else {
                log_msg("警告: 无法获取主窗口");
            }

            // 注册全局快捷键
            let shortcut = settings_clone.toggle_shortcut.clone();
            register_global_shortcut(&app_handle, &shortcut);

            // 启动剪贴板监听线程
            start_clipboard_watcher(app_handle.clone());

            // 启动时执行一次全面清理
            {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let max_storage_mb = if let Ok(settings) = state.settings.lock() {
                        settings.max_storage_mb
                    } else { 200 };
                    if let Ok(history) = state.history.lock() {
                        let keep_ids: Vec<i64> = history.iter().map(|i| i.id).collect();
                        drop(history);
                        cleanup_old_images(&keep_ids, max_storage_mb);
                        log_msg(&format!("启动清理完成，图片目录 {:.1}MB", get_images_total_size() as f64 / 1024.0 / 1024.0));
                    }
                }
            }

            // 定期清理（每 6 小时）
            let app_h_cleanup = app_handle.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(6 * 60 * 60));
                    if let Some(state) = app_h_cleanup.try_state::<AppState>() {
                        let max_storage_mb = if let Ok(settings) = state.settings.lock() {
                            settings.max_storage_mb
                        } else { 200 };
                        if let Ok(history) = state.history.lock() {
                            let keep_ids: Vec<i64> = history.iter().map(|i| i.id).collect();
                            drop(history);
                            cleanup_old_images(&keep_ids, max_storage_mb);
                            log_msg(&format!("定期清理完成，图片目录 {:.1}MB", get_images_total_size() as f64 / 1024.0 / 1024.0));
                        }
                    }
                }
            });

            // 版本自动检查（5 秒后）
            let app_h = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        log_msg(&format!("创建 tokio runtime 失败: {}", e));
                        return;
                    }
                };
                let result = rt.block_on(commands::check_for_update());
                if result.available {
                    if let Some(window) = app_h.get_webview_window("main") {
                        let _ = window.emit("update-check-result", &result);
                    }
                }
            });

            // 监听 settings-updated 事件，同步托盘菜单文字
            use tauri::Listener;
            let app_h_listen = app_handle.clone();
            app.listen("settings-updated", move |_| {
                let state = app_h_listen.state::<AppState>();
                if let Ok(label) = state.autostart_menu_text.lock() {
                    let _ = autostart_item_for_listener.set_text(label.as_str());
                };
            });

            log_msg("setup 完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_history,
            commands::get_settings,
            commands::save_settings_cmd,
            commands::delete_item,
            commands::pin_item,
            commands::clear_history,
            commands::paste_item,
            commands::copy_item,
            commands::get_image_url,
            commands::get_image_data_url,
            commands::get_thumbnail_data_url,
            commands::get_storage_info,
            commands::toggle_window,
            commands::hide_window,
            commands::show_window,
            commands::check_for_update,
            commands::skip_update_version,
            commands::set_autostart,
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            log_msg("Tauri 构建成功，开始运行");
            app.run(|_app_handle, event| {
                if let RunEvent::Exit = event {
                    log_msg("ClipMate 退出");
                }
            });
        }
        Err(e) => {
            log_msg(&format!("Tauri 构建失败: {}", e));
            // 等待日志写入
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

// ─── 剪贴板图片编码 ────────────────────────────────────────────

/// 将剪贴板 RGBA 数据编码为 PNG，健壮处理数据长度不匹配
fn encode_clipboard_image(data: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let expected_len = width * height * 4;

    if data.len() == expected_len {
        // 标准情况：数据长度完全匹配
        let rgba = image::RgbaImage::from_raw(width as u32, height as u32, data.to_vec())
            .ok_or_else(|| format!("from_raw 失败: {}x{} 需要{}字节，实际{}字节", width, height, expected_len, data.len()))?;
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        rgba.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| format!("PNG编码失败: {}", e))?;
        Ok(buf)
    } else if data.len() > expected_len {
        // 数据比预期多：可能包含行对齐填充（DIB stride），尝试逐行提取
        log_msg(&format!("图片数据超长: 期望{}字节，实际{}字节，尝试行对齐处理", expected_len, data.len()));

        // 计算可能的 stride（每行字节数，向上取整到4字节）
        let row_bytes = width * 4;
        let stride = (row_bytes + 3) & !3; // 4字节对齐

        if data.len() >= stride * height {
            let mut clean_data = Vec::with_capacity(expected_len);
            for y in 0..height {
                let offset = y * stride;
                clean_data.extend_from_slice(&data[offset..offset + row_bytes]);
            }
            let rgba = image::RgbaImage::from_raw(width as u32, height as u32, clean_data)
                .ok_or_else(|| "行对齐处理后 from_raw 仍然失败".to_string())?;
            let mut buf = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buf);
            rgba.write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| format!("PNG编码失败: {}", e))?;
            Ok(buf)
        } else {
            // stride 不匹配，直接截断到期望长度尝试
            log_msg(&format!("stride不匹配 (stride={}, 需要{})，截断尝试", stride, data.len() / height));
            let truncated = &data[..expected_len.min(data.len())];
            let mut padded = truncated.to_vec();
            padded.resize(expected_len, 0);

            let rgba = image::RgbaImage::from_raw(width as u32, height as u32, padded)
                .ok_or_else(|| format!("截断后 from_raw 仍然失败: {}x{}", width, height))?;
            let mut buf = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buf);
            rgba.write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| format!("PNG编码失败: {}", e))?;
            Ok(buf)
        }
    } else {
        // 数据比预期少：填充零
        log_msg(&format!("图片数据不足: 期望{}字节，实际{}字节，零填充", expected_len, data.len()));
        let mut padded = data.to_vec();
        padded.resize(expected_len, 0);

        let rgba = image::RgbaImage::from_raw(width as u32, height as u32, padded)
            .ok_or_else(|| format!("填充后 from_raw 失败: {}x{}", width, height))?;
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        rgba.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| format!("PNG编码失败: {}", e))?;
        Ok(buf)
    }
}

// ─── 窗口定位 ──────────────────────────────────────────────────

fn position_window(window: &tauri::WebviewWindow, app: &AppHandle) {
    let is_right = if let Some(state) = app.try_state::<AppState>() {
        if let Ok(settings) = state.settings.lock() {
            settings.layout == "right"
        } else {
            false
        }
    } else {
        false
    };

    let (work_left, work_top, work_right, work_bottom) = models::get_work_area();
    let work_w = work_right - work_left;
    let work_h = work_bottom - work_top;

    let (w, h, x, y) = if is_right {
        let w = 360;
        let h = work_h;
        let x = work_right - w;
        let y = work_top;
        (w, h, x, y)
    } else {
        let w = work_w;
        let h = 280;
        let x = work_left;
        let y = work_bottom - h;
        (w, h, x, y)
    };

    log_msg(&format!("窗口定位: {}x{} at ({},{}), 工作区: {}x{}..{}x{}, 布局: {}",
        w, h, x, y, work_left, work_top, work_right, work_bottom,
        if is_right { "right" } else { "bottom" }));

    let _ = window.set_size(tauri::LogicalSize::new(w as f64, h as f64));
    let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
}

// ─── 全局快捷键 ────────────────────────────────────────────────

fn register_global_shortcut(app: &AppHandle, shortcut: &str) {
    let gs = app.global_shortcut();
    let _ = gs.unregister(shortcut);

    if let Err(e) = gs.on_shortcut(shortcut, move |app, _shortcut, event| {
        use tauri_plugin_global_shortcut::ShortcutState;
        if event.state != ShortcutState::Pressed {
            return;
        }
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.set_focus();
                    let _ = window.emit("window-shown", ());
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut last_shown) = state.last_shown.lock() {
                            *last_shown = std::time::Instant::now();
                        }
                    }
                }
            }
    }) {
        log_msg(&format!("快捷键注册失败: {}", e));
        if shortcut != "Ctrl+Shift+V" {
            log_msg("回退到默认快捷键 Ctrl+Shift+V");
            let _ = gs.on_shortcut("Ctrl+Shift+V", move |app, _shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;
                if event.state != ShortcutState::Pressed { return; }
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                    else {
                        let _ = window.show(); let _ = window.set_skip_taskbar(true); let _ = window.set_focus();
                        let _ = window.emit("window-shown", ());
                        if let Some(state) = app.try_state::<AppState>() {
                            if let Ok(mut last_shown) = state.last_shown.lock() {
                                *last_shown = std::time::Instant::now();
                            }
                        }
                    }
                }
            });
        }
        return;
    }

    log_msg(&format!("全局快捷键已注册: {}", shortcut));
}

/// 重新注册快捷键：先注销旧的，再注册新的
pub fn reregister_global_shortcut(app: &AppHandle, old_shortcut: &str, new_shortcut: &str) {
    let gs = app.global_shortcut();
    let _ = gs.unregister(old_shortcut);
    log_msg(&format!("已注销旧快捷键: {}", old_shortcut));
    register_global_shortcut(app, new_shortcut);
}

// ─── Win32 剪贴板图片读取回退 ──────────────────────────────────

/// 当 arboard 无法读取剪贴板图片时，使用 Win32 API 直接读取
#[cfg(target_os = "windows")]
fn read_clipboard_image_win32() -> Option<(Vec<u8>, usize, usize)> {
    use windows::Win32::System::DataExchange::{
        OpenClipboard, CloseClipboard, GetClipboardData,
        IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };
    use windows::Win32::Foundation::{HWND, HGLOBAL};

    unsafe {
        if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
            log_msg("Win32回退: 无法打开剪贴板");
            return None;
        }

        let result = 'outer: {
            // 1. 尝试 CF_PNG（最可靠，直接获取 PNG 原始字节）
            let png_format = RegisterClipboardFormatW(windows::core::w!("PNG"));
            if png_format != 0 {
                if IsClipboardFormatAvailable(png_format).is_ok() {
                    if let Ok(handle) = GetClipboardData(png_format) {
                        if let Some(data) = read_global_memory(HGLOBAL(handle.0)) {
                            log_msg(&format!("Win32回退: 读取到 CF_PNG ({}字节)", data.len()));
                            if let Ok(img) = image::load_from_memory(&data) {
                                let (w, h) = (img.width() as usize, img.height() as usize);
                                break 'outer Some((data, w, h));
                            }
                        }
                    }
                }
            }

            // 2. 尝试 CF_DIB（DIB 格式 ID = 8）
            let cf_dib: u32 = 8;
            if IsClipboardFormatAvailable(cf_dib).is_ok() {
                if let Ok(handle) = GetClipboardData(cf_dib) {
                    if let Some(data) = read_global_memory(HGLOBAL(handle.0)) {
                        log_msg(&format!("Win32回退: 读取到 CF_DIB ({}字节)", data.len()));
                        if let Some((png_bytes, w, h)) = convert_dib_to_png(&data) {
                            break 'outer Some((png_bytes, w, h));
                        }
                    }
                }
            }

            log_msg("Win32回退: 剪贴板中无可用图片格式");
            None
        };

        let _ = CloseClipboard();
        result
    }
}

/// 读取 Win32 全局内存句柄中的数据
#[cfg(target_os = "windows")]
unsafe fn read_global_memory(handle: windows::Win32::Foundation::HGLOBAL) -> Option<Vec<u8>> {
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalSize};

    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        return None;
    }
    let size = GlobalSize(handle) as usize;
    if size == 0 {
        let _ = GlobalUnlock(handle);
        return None;
    }
    let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(handle);
    Some(data)
}

/// 将 DIB（设备无关位图）数据转换为 PNG
#[cfg(target_os = "windows")]
fn convert_dib_to_png(dib_data: &[u8]) -> Option<(Vec<u8>, usize, usize)> {
    if dib_data.len() < 40 {
        log_msg(&format!("DIB数据太短: {}字节", dib_data.len()));
        return None;
    }

    // 解析 BITMAPINFOHEADER（40字节）
    let bi_size = u32::from_le_bytes(dib_data[0..4].try_into().ok()?) as usize;
    let bi_width = i32::from_le_bytes(dib_data[4..8].try_into().ok()?) as usize;
    let bi_height_raw = i32::from_le_bytes(dib_data[8..12].try_into().ok()?);
    let bi_bit_count = u16::from_le_bytes(dib_data[14..16].try_into().ok()?) as usize;
    let bi_compression = u32::from_le_bytes(dib_data[16..20].try_into().ok()?);

    let top_down = bi_height_raw < 0;
    let bi_height = if top_down { -bi_height_raw as usize } else { bi_height_raw as usize };

    log_msg(&format!("DIB信息: {}x{}, {}bit, compression={}, top_down={}",
        bi_width, bi_height, bi_bit_count, bi_compression, top_down));

    // 支持的压缩格式：
    //   0 = BI_RGB（无压缩）
    //   3 = BI_BITFIELDS（32位下带颜色掩码，像素数据仍是未压缩 BGRA）
    //   4 = BI_JPEG / 5 = BI_PNG（剪贴板中不应出现，但记录日志）
    if bi_compression != 0 && bi_compression != 3 {
        log_msg(&format!("DIB压缩格式不支持: compression={}（0=未压缩,3=BI_BITFIELDS）", bi_compression));
        return None;
    }
    if bi_bit_count != 32 && bi_bit_count != 24 {
        log_msg(&format!("DIB位深不支持: {}bit（仅支持24/32位）", bi_bit_count));
        return None;
    }

    // BI_BITFIELDS (compression=3) 时，头后面紧跟3个掩码DWORD（12字节）
    // 然后才是像素数据；BI_RGB (compression=0) 时直接从头后面开始
    let mask_size = if bi_compression == 3 { 12usize } else { 0 };
    let pixel_data_offset = bi_size + mask_size;
    if pixel_data_offset >= dib_data.len() {
        log_msg(&format!("DIB像素数据偏移超出范围: offset={}, len={}", pixel_data_offset, dib_data.len()));
        return None;
    }

    let pixels = &dib_data[pixel_data_offset..];
    let bytes_per_pixel = bi_bit_count / 8;
    let row_bytes = bi_width * bytes_per_pixel;
    let row_stride = (row_bytes + 3) & !3; // 4字节对齐

    if pixels.len() < row_stride * bi_height {
        log_msg(&format!("DIB像素数据不足: 需要{}字节，实际{}字节",
            row_stride * bi_height, pixels.len()));
        return None;
    }

    // 转换 BGR/BGRA → RGBA，同时处理 top-down/bottom-up
    let mut rgba_data = Vec::with_capacity(bi_width * bi_height * 4);
    for y in 0..bi_height {
        let src_y = if top_down { y } else { bi_height - 1 - y };
        let row_start = src_y * row_stride;
        for x in 0..bi_width {
            let pixel_start = row_start + x * bytes_per_pixel;
            if pixel_start + bytes_per_pixel > pixels.len() { break; }
            let b = pixels[pixel_start];
            let g = pixels[pixel_start + 1];
            let r = pixels[pixel_start + 2];
            let a = if bytes_per_pixel == 4 { pixels[pixel_start + 3] } else { 255 };
            rgba_data.extend_from_slice(&[r, g, b, a]);
        }
    }

    // 编码为 PNG
    match image::RgbaImage::from_raw(bi_width as u32, bi_height as u32, rgba_data) {
        Some(img) => {
            let mut buf = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut buf);
            match img.write_to(&mut cursor, image::ImageFormat::Png) {
                Ok(_) => Some((buf, bi_width, bi_height)),
                Err(e) => {
                    log_msg(&format!("DIB转PNG编码失败: {}", e));
                    None
                }
            }
        }
        None => {
            log_msg("DIB转RGBA失败: from_raw返回None");
            None
        }
    }
}

// ─── 剪贴板监听 ────────────────────────────────────────────────

fn start_clipboard_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_text = String::new();
        let mut last_image_hash = String::new();
        let mut last_save = std::time::Instant::now() - Duration::from_secs(10);
        let mut clipboard_fail_count: u32 = 0; // 连续失败计数
        let mut last_clipboard_err_logged = false;
        let mut img_err_count: u32 = 0; // 图片读取错误计数

        loop {
            std::thread::sleep(Duration::from_millis(1000));

            let mut clipboard = match arboard::Clipboard::new() {
                Ok(cb) => {
                    if clipboard_fail_count > 0 {
                        log_msg(&format!("剪贴板访问恢复（之前连续失败 {} 次）", clipboard_fail_count));
                    }
                    clipboard_fail_count = 0;
                    last_clipboard_err_logged = false;
                    cb
                }
                Err(e) => {
                    clipboard_fail_count += 1;
                    if !last_clipboard_err_logged {
                        log_msg(&format!("剪贴板访问失败（第{}次）: {}", clipboard_fail_count, e));
                        last_clipboard_err_logged = true;
                    }
                    continue;
                }
            };

            // 检查文字（注意：不能用 continue 跳过图片检查）
            let mut text_processed = false;
            match clipboard.get_text() {
                Ok(text) if !text.is_empty() && text != last_text => {
                    log_msg(&format!("剪贴板文字: {}...", &text.chars().take(50).collect::<String>()));
                    last_text = text.clone();
                    last_image_hash.clear();

                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut history) = state.history.lock() {
                            if let Ok(mut next_id) = state.next_id.lock() {
                                // 去重：已存在则移到最前面（更新时间），不存在则新增
                                let dup_pos = history.iter().position(|i| matches!(&i.content, ClipContent::Text { content } if *content == text));

                                if let Some(pos) = dup_pos {
                                    // 已存在：移到最前面，更新时间
                                    let mut item = history.remove(pos);
                                    item.time = chrono::Local::now().to_rfc3339();
                                    history.insert(0, item);

                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_save) > Duration::from_millis(800) {
                                        save_history(&history);
                                        last_save = now;
                                    }
                                    drop(history);

                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("history-updated", ());
                                    }
                                } else {
                                    // 新条目
                                    let item = ClipItem {
                                        id: *next_id,
                                        content: ClipContent::Text { content: text },
                                        time: chrono::Local::now().to_rfc3339(),
                                        pinned: false,
                                    };
                                    *next_id += 1;
                                    history.insert(0, item.clone());

                                    let max = if let Ok(settings) = state.settings.lock() {
                                        settings.max_items
                                    } else { 200 };
                                    while history.len() > max {
                                        if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                                            history.remove(pos);
                                        } else { break; }
                                    }

                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_save) > Duration::from_millis(800) {
                                        save_history(&history);
                                        last_save = now;
                                    }
                                    drop(history);

                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("history-updated", ());
                                    }
                                }
                                text_processed = true;
                            }
                        }
                    }
                }
                _ => {}
            }

            // 检查图片（始终执行，不再被文字处理跳过）
            // 先尝试 arboard，失败则用 Win32 API 回退
            let image_result: Option<(Vec<u8>, usize, usize)> = match clipboard.get_image() {
                Ok(img) => {
                    // arboard 成功，将 RGBA 编码为 PNG
                    let img_data: Vec<u8> = img.bytes.to_vec();
                    match encode_clipboard_image(&img_data, img.width, img.height) {
                        Ok(png_data) => Some((png_data, img.width, img.height)),
                        Err(e) => {
                            log_msg(&format!("arboard图片编码失败: {}，尝试Win32回退", e));
                            read_clipboard_image_win32()
                        }
                    }
                }
                Err(e) => {
                    // arboard 失败，尝试 Win32 API 回退
                    img_err_count += 1;
                    if img_err_count <= 3 || img_err_count % 100 == 0 {
                        log_msg(&format!("arboard图片读取失败（第{}次）: {}，尝试Win32回退", img_err_count, e));
                    }
                    read_clipboard_image_win32()
                }
            };

            if let Some((png_data, img_w, img_h)) = image_result {
                // 用 PNG 数据计算 hash 去重
                let hash = compute_image_hash(&png_data);
                if hash != last_image_hash {
                    log_msg(&format!("剪贴板图片变化 ({}x{}, {}字节)", img_w, img_h, png_data.len()));
                    last_image_hash = hash.clone();
                    if !text_processed {
                        last_text.clear();
                    }

                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut history) = state.history.lock() {
                            if let Ok(mut next_id) = state.next_id.lock() {
                                let id = *next_id;
                                let preview = format!("图片 ({}x{})", img_w, img_h);

                                let file_path = images_dir().join(format!("{}.png", id));
                                let write_ok = std::fs::write(&file_path, &png_data).is_ok();
                                if !write_ok {
                                    log_msg(&format!("图片文件写入失败: {:?}", file_path));
                                    continue;
                                }
                                log_msg(&format!("图片已保存: {}.png ({}KB)", id, png_data.len() / 1024));

                                // 生成缩略图
                                generate_and_save_thumbnail(&png_data, id);

                                {
                                    let file_url = format!("file:///{}", file_path.to_string_lossy().replace('\\', "/"));

                                    let item = ClipItem {
                                        id,
                                        content: ClipContent::Image {
                                            path: file_url,
                                            preview,
                                        },
                                        time: chrono::Local::now().to_rfc3339(),
                                        pinned: false,
                                    };
                                    *next_id += 1;
                                    history.insert(0, item);

                                    let max = if let Ok(settings) = state.settings.lock() {
                                        settings.max_items
                                    } else { 200 };
                                    while history.len() > max {
                                        if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                                            history.remove(pos);
                                        } else { break; }
                                    }

                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_save) > Duration::from_millis(800) {
                                        save_history(&history);
                                        last_save = now;
                                    }
                                    drop(history);

                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("history-updated", ());
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // 图片 hash 与上次相同（重复复制同一张图），将历史中的已有项移到最前面
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut history) = state.history.lock() {
                            // 找到 hash 匹配的图片项：通过重新计算已有图片的 hash 来匹配
                            let mut found_pos = None;
                            for (i, item) in history.iter().enumerate() {
                                if let ClipContent::Image { path, .. } = &item.content {
                                    // 读取图片文件计算 hash
                                    let local_path = path.trim_start_matches("file:///");
                                    let local_path = local_path.replace('/', "\\");
                                    if let Ok(data) = std::fs::read(&local_path) {
                                        let item_hash = compute_image_hash(&data);
                                        if item_hash == hash {
                                            found_pos = Some(i);
                                            break;
                                        }
                                    }
                                }
                            }
                            if let Some(pos) = found_pos {
                                let mut item = history.remove(pos);
                                item.time = chrono::Local::now().to_rfc3339();
                                history.insert(0, item);

                                let now = std::time::Instant::now();
                                if now.duration_since(last_save) > Duration::from_millis(800) {
                                    save_history(&history);
                                    last_save = now;
                                }
                                drop(history);

                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.emit("history-updated", ());
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

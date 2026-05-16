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
    let history = load_history();
    let settings = load_settings();
    let next_id = history.iter().map(|i| i.id).max().unwrap_or(0) + 1;

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

            // 托盘图标：安全加载，失败则跳过托盘
            let icon_result = app.default_window_icon().cloned();
            if let Some(icon) = icon_result {
                match TrayIconBuilder::new()
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
                                        {
                                            use tauri_plugin_autostart::ManagerExt;
                                            let manager = app.autolaunch();
                                            if enable {
                                                let _ = manager.enable();
                                            } else {
                                                let _ = manager.disable();
                                            }
                                        }
                                    }
                                }
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

// ─── 窗口定位 ──────────────────────────────────────────────────

fn position_window(window: &tauri::WebviewWindow, app: &AppHandle) {
    let (is_right, max_items) = if let Some(state) = app.try_state::<AppState>() {
        if let Ok(settings) = state.settings.lock() {
            (settings.layout == "right", settings.max_items)
        } else {
            (false, 200)
        }
    } else {
        (false, 200)
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

// ─── 剪贴板监听 ────────────────────────────────────────────────

fn start_clipboard_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_text = String::new();
        let mut last_image_hash = String::new();
        let mut last_save = std::time::Instant::now() - Duration::from_secs(10);

        loop {
            std::thread::sleep(Duration::from_millis(1200));

            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                // 检查文字
                match clipboard.get_text() {
                    Ok(text) if !text.is_empty() && text != last_text => {
                        log_msg(&format!("剪贴板文字: {}...", &text[..text.len().min(50)]));
                        last_text = text.clone();
                        last_image_hash.clear();

                        if let Some(state) = app.try_state::<AppState>() {
                            if let Ok(mut history) = state.history.lock() {
                                if let Ok(mut next_id) = state.next_id.lock() {
                                    // 去重
                                    if history.iter().any(|i| matches!(&i.content, ClipContent::Text { content } if *content == text)) {
                                        continue;
                                    }

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
                            }
                        }
                    }
                    _ => {}
                }

                // 检查图片
                match clipboard.get_image() {
                    Ok(img) => {
                        let hash = compute_image_hash(&img.bytes);
                        if hash != last_image_hash {
                            log_msg("剪贴板图片变化");
                            last_image_hash = hash;
                            last_text.clear();

                            if let Some(state) = app.try_state::<AppState>() {
                                if let Ok(mut history) = state.history.lock() {
                                    if let Ok(mut next_id) = state.next_id.lock() {
                                        let id = *next_id;
                                        let img_data: Vec<u8> = img.bytes.to_vec();
                                        let preview = format!("图片 ({}x{})", img.width, img.height);

                                        // 将剪贴板RGBA数据编码为PNG
                                        let png_data = match (|| -> Result<Vec<u8>, String> {
                                            let rgba = image::RgbaImage::from_raw(
                                                img.width as u32, img.height as u32, img_data
                                            ).ok_or("图片数据与尺寸不匹配")?;
                                            let mut buf = Vec::new();
                                            let mut cursor = std::io::Cursor::new(&mut buf);
                                            rgba.write_to(&mut cursor, image::ImageFormat::Png)
                                                .map_err(|e| format!("PNG编码失败: {}", e))?;
                                            Ok(buf)
                                        })() {
                                            Ok(data) => data,
                                            Err(e) => {
                                                log_msg(&format!("图片编码失败: {}", e));
                                                continue;
                                            }
                                        };

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
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}

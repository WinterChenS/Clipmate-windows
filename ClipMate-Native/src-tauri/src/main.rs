use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;

mod models;
mod commands;

use models::*;

fn main() {
    log_msg("=== ClipMate Native (Rust/Tauri) 启动 ===");

    // 加载数据
    let history = load_history();
    let settings = load_settings();
    let next_id = history.iter().map(|i| i.id).max().unwrap_or(0) + 1;

    log_msg(&format!("加载历史: {} 条, 布局: {}", history.len(), settings.layout));

    let state = AppState {
        history: Mutex::new(history),
        settings: Mutex::new(settings.clone()),
        last_clipboard_text: Mutex::new(String::new()),
        last_clipboard_image_hash: Mutex::new(String::new()),
        visible: Mutex::new(false),
        next_id: Mutex::new(next_id),
    };

    // 托盘菜单
    let tray = SystemTray::new()
        .with_menu(
            SystemTrayMenu::new()
                .add_item(tauri::CustomMenuItem::new("show", "显示 ClipMate"))
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(tauri::CustomMenuItem::new("autostart", if settings.auto_start { "✓ 开机启动" } else { "开机启动" }))
                .add_native_item(SystemTrayMenuItem::Separator)
                .add_item(tauri::CustomMenuItem::new("quit", "退出")),
        );

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .system_tray(tray)
        .on_system_tray_event(|app, event| {
            match event {
                tauri::SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "autostart" => {
                            let state = app.state::<AppState>();
                            let mut settings = state.settings.lock().unwrap();
                            settings.auto_start = !settings.auto_start;
                            save_settings(&settings);
                            // TODO: 实际注册/取消开机启动
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                }
                tauri::SystemTrayEvent::DoubleClick { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 设置窗口位置
            if let Some(window) = app.get_webview_window("main") {
                position_window(&window, &app_handle);

                // 窗口失焦隐藏
                let app_h = app_handle.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Focused(false) => {
                            // 延迟 200ms 检查，避免点击内部元素时误触
                            let app_h = app_h.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(200));
                                if let Some(w) = app_h.get_webview_window("main") {
                                    if !w.is_focused().unwrap_or(false) {
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
            }

            // 注册全局快捷键
            let shortcut = settings.toggle_shortcut.clone();
            register_global_shortcut(&app_handle, &shortcut);

            // 启动剪贴板监听线程
            start_clipboard_watcher(app_handle.clone());

            // 版本自动检查（5 秒后）
            let app_h = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                let rt = tokio::runtime::Runtime::new().unwrap();
                let result = rt.block_on(commands::check_for_update());
                if result.available {
                    if let Some(window) = app_h.get_webview_window("main") {
                        let _ = window.emit("update-check-result", &result);
                    }
                }
            });

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
            commands::toggle_window,
            commands::hide_window,
            commands::show_window,
            commands::check_for_update,
            commands::skip_update_version,
        ])
        .run(|_app_handle, event| {
            if let RunEvent::Exit = event {
                log_msg("ClipMate 退出");
            }
        });
}

// ─── 窗口定位 ──────────────────────────────────────────────────

fn position_window(window: &tauri::WebviewWindow, app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();

    let monitor = window.primary_monitor().ok().flatten();
    let (screen_w, screen_h) = match monitor {
        Some(m) => (m.size().width as i32, m.size().height as i32),
        None => (1920, 1080),
    };

    let is_right = settings.layout == "right";
    let (w, h, x, y) = if is_right {
        let w = 360;
        let h = screen_h;
        let x = screen_w - w;
        let y = 0;
        (w, h, x, y)
    } else {
        let w = screen_w;
        let h = 300;
        let x = 0;
        let y = screen_h - h;
        (w, h, x, y)
    };

    let _ = window.set_size(tauri::LogicalSize::new(w as f64, h as f64));
    let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
}

// ─── 全局快捷键 ────────────────────────────────────────────────

fn register_global_shortcut(app: &AppHandle, shortcut: &str) {
    if let Ok(gs) = app.global_shortcut() {
        let shortcut_str = shortcut.to_string();
        let _ = gs.register(shortcut, move |app, _shortcut, event| {
            // 只在按下时触发，松开忽略
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
        log_msg(&format!("全局快捷键已注册: {}", shortcut));
    }
}

// ─── 剪贴板监听 ────────────────────────────────────────────────

fn start_clipboard_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_text = String::new();
        let mut last_image_hash = String::new();

        loop {
            std::thread::sleep(Duration::from_millis(1200));

            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                // 检查文字
                match clipboard.get_text() {
                    Ok(text) if !text.is_empty() && text != last_text => {
                        log_msg(&format!("剪贴板文字: {}...", &text[..text.len().min(50)]));
                        last_text = text.clone();
                        last_image_hash.clear(); // 文字和图片互斥

                        let state = app.state::<AppState>();
                        let mut history = state.history.lock().unwrap();
                        let mut next_id = state.next_id.lock().unwrap();

                        // 去重
                        if history.iter().any(|i| matches!(&i.content, ClipContent::Text { content } if content == &text)) {
                            continue;
                        }

                        let item = ClipItem {
                            id: *next_id,
                            content: ClipContent::Text {
                                content: text,
                            },
                            time: chrono::Local::now().to_rfc3339(),
                            pinned: false,
                        };
                        *next_id += 1;

                        history.insert(0, item.clone());

                        // 超过最大条数时移除（保留 pinned）
                        let max = state.settings.lock().unwrap().max_items;
                        while history.len() > max {
                            if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                                history.remove(pos);
                            } else {
                                break;
                            }
                        }

                        save_history(&history);
                        let keep_ids: Vec<i64> = history.iter().map(|i| i.id).collect();
                        drop(history);

                        // 通知前端
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("history-updated", &());
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

                            let state = app.state::<AppState>();
                            let mut history = state.history.lock().unwrap();
                            let mut next_id = state.next_id.lock().unwrap();

                            // 保存图片文件
                            let id = *next_id;
                            let img_data: Vec<u8> = img.bytes.to_vec();
                            let preview = format!("图片 ({}x{})", img.width, img.height);

                            if let Some(_path) = save_clipboard_image(&img_data, id) {
                                let file_path = images_dir().join(format!("{}.png", id));
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

                                let max = state.settings.lock().unwrap().max_items;
                                while history.len() > max {
                                    if let Some(pos) = history.iter().rposition(|i| !i.pinned) {
                                        history.remove(pos);
                                    } else {
                                        break;
                                    }
                                }

                                save_history(&history);
                                drop(history);

                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.emit("history-updated", &());
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

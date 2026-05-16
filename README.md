# ClipMate

<p align="center">
  <strong>仿 macOS Paste 的 Windows 剪贴板管理器</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-24C8D8" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-1.95+-DEA584" alt="Rust" />
  <img src="https://img.shields.io/badge/Vite-6-646cff" alt="Vite" />
  <img src="https://img.shields.io/badge/Windows-11-0078d4" alt="Windows" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

---

## 功能特性

- **全局快捷键** — `Ctrl + Shift + V` 随时唤起面板
- **双布局模式** — 底部横条（仿 macOS Paste）/ 右侧侧边栏，可自由切换
- **多类型支持** — 文字、图片、链接，自动分类识别
- **智能搜索** — 实时过滤剪贴板历史记录
- **固定收藏** — 重要内容 Pin 到顶部，不怕被覆盖
- **图片文件化存储** — PNG 文件替代 base64，内存占用降低 ~99%
- **图片指纹去重** — MD5 快速比对，避免重复存储相同图片
- **自动清理机制** — 7 天过期清理 + 200MB 总容量上限 + 孤儿文件回收
- **历史持久化** — JSON 文件存储 + 图片磁盘分离，重启不丢失（最多 200 条）
- **毛玻璃 UI** — 半透明模糊背景，现代感十足
- **系统托盘** — 最小化到托盘常驻后台
- **开机自启** — 可选开机自动启动（托盘菜单控制）
- **单实例锁** — 防止重复启动多个窗口
- **键盘导航** — 方向键切换、Enter 粘贴、Esc 关闭
- **快捷键自定义** — 支持录制自定义全局快捷键
- **NSIS/MSI 安装包** — 标准 Windows 安装程序

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + Shift + V` | 显示 / 隐藏面板（可自定义） |
| `Ctrl + ,` | 打开设置面板 |
| `双击` | 粘贴选中项 |
| `Enter` | 粘贴当前选中项 |
| `Esc` | 关闭面板 |
| `←` `→` / `↑` `↓` | 切换选中项（方向键随布局自适应） |

## 项目结构

```
clipboard-manager/
├── src/                    # 前端源码 (vanilla JS)
│   ├── main.js             # 主应用逻辑（搜索、双布局、设置、键盘导航）
│   └── styles.css          # 全局样式（毛玻璃 + 双模式 + 亮色/暗色主题）
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── main.rs         # 窗口管理、托盘、剪贴板监听、全局快捷键、定期清理
│   │   ├── commands.rs     # Tauri 命令（CRUD、粘贴、设置、自启动）
│   │   └── models.rs       # 数据模型、持久化、图片存储、MD5 去重、清理
│   ├── icons/              # 应用图标资源
│   ├── capabilities/       # Tauri 权限配置
│   ├── Cargo.toml          # Rust 依赖
│   └── tauri.conf.json     # Tauri 配置
├── index.html              # HTML 入口
├── package.json            # 前端依赖
├── vite.config.js          # Vite 配置
└── build.bat               # Windows 一键构建脚本
```

## 技术栈

| 技术 | 用途 | 版本 |
|------|------|------|
| [Tauri](https://tauri.app/) | 桌面应用框架 | 2.x |
| [Rust](https://www.rust-lang.org/) | 后端核心 | 1.95+ |
| [Vite](https://vitejs.dev/) | 前端构建工具 | 6.x |
| [Vanilla JS](https://developer.mozilla.org/en-US/docs/Web/JavaScript) | UI 渲染 | ES6+ |

### Rust 核心依赖

| 依赖 | 用途 |
|------|------|
| `arboard` | 剪贴板读写 |
| `tauri-plugin-global-shortcut` | 全局快捷键 |
| `tauri-plugin-autostart` | 开机自启动 |
| `tauri-plugin-single-instance` | 单实例锁 |
| `tauri-plugin-opener` | 打开外部链接 |
| `reqwest` | HTTP 请求（版本检查） |
| `windows` | Win32 API（SendInput 模拟粘贴） |

## 开发指南

### 环境要求

- Node.js >= 18
- Rust >= 1.70 (`rustup` 安装)
- Windows 10/11

### 安装依赖

```bash
cd clipboard-manager
npm install
```

### 开发模式

```bash
# 启动 Tauri 开发服务器（前端热重载 + Rust 自动重编译）
npx tauri dev
```

### 构建

```bash
# 一键构建（前端 + Rust 编译 + 打包安装程序）
build.bat

# 或手动构建
npx tauri build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录：
- `nsis/ClipMate_1.2.2_x64-setup.exe` — NSIS 安装包
- `msi/ClipMate_1.2.2_x64_en-US.msi` — MSI 安装包
- `../clipmate.exe` — 独立可执行文件

## 数据存储

所有数据存放在 `%APPDATA%/clipmate/` 下：

| 文件 / 目录 | 说明 |
|-------------|------|
| `clipboard-history.json` | 剪贴板历史 + 固定项 |
| `settings.json` | 用户设置（布局模式、最大条数、快捷键等） |
| `images/{id}.png` | 图片文件存储（PNG 格式） |
| `debug.log` | 运行日志（自动轮转，上限 512KB） |

## License

[MIT](LICENSE)

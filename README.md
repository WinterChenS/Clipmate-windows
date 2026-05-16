# ClipMate

<p align="center">
  <strong>仿 macOS Paste 的 Windows 剪贴板管理器</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-29-blue" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-61dafb" alt="React" />
  <img src="https://img.shields.io/badge/Vite-5-646cff" alt="Vite" />
  <img src="https://img.shields.io/badge/TailwindCSS-3-06B6D4" alt="TailwindCSS" />
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
- **图片文件化存储** — PNG 文件替代 base64，内存占用降低 ~99%（V5 核心）
- **图片指纹去重** — MD5 快速比对，避免重复存储相同图片
- **懒加载渲染** — LazyImage 组件按需加载，滚动流畅不卡顿
- **自动清理机制** — 7 天过期清理 + 200MB 总容量上限 + 孤儿文件回收
- **历史持久化** — JSON 文件存储 + 图片磁盘分离，重启不丢失（最多 200 条）
- **毛玻璃 UI** — 半透明模糊背景，现代感十足
- **系统托盘** — 最小化到托盘常驻后台
- **开机自启** — 可选开机自动启动（托盘菜单控制）
- **单实例锁** — 防止重复启动多个窗口
- **NSIS 安装包** — 标准 Windows 安装程序，支持自定义目录、桌面快捷方式、开始菜单

## 界面预览

### 底部模式（默认）

底部居中显示宽扁横条，卡片横向滚动排列，适合快速浏览和预览多条剪贴板记录。

### 右侧模式

屏幕右侧显示窄高侧边栏，卡片垂直列表排列，每条内容展示更完整，适合阅读长文本。

### 设置面板

点击搜索栏 `⚙` 按钮或按 `Ctrl + ,` 打开：

- 布局模式切换（可视化预览）
- 最大记录数调节（50 ~ 200）
- 状态栏显示开关

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + Shift + V` | 显示 / 隐藏面板 |
| `Ctrl + ,` | 打开设置面板 |
| `双击` | 粘贴选中项 |
| `Enter` | 粘贴当前选中项 |
| `Esc` | 关闭面板 |
| `←` `→` / `↑` `↓` | 切换选中项（方向键随布局自适应） |

## 项目结构

```
clipboard-manager/
├── assets/                  # 应用图标资源
│   ├── icon.ico             # 主图标（多尺寸 ICO）
│   └── tray-icon.png        # 托盘图标
├── src/
│   ├── main/                # Electron 主进程
│   │   ├── main.js          # 窗口管理、托盘、剪贴板轮询、IPC、图片存储系统
│   │   └── preload.js       # contextBridge 安全桥接
│   └── renderer/            # React 渲染进程
│       ├── App.jsx          # 主应用组件（双布局 + 设置 + LazyImage）
│       ├── main.jsx         # React 入口
│       └── styles/
│           └── index.css    # 全局样式（毛玻璃 + 双模式 + 图片过渡动画）
├── dist/                    # Vite 构建产物
├── dist-electron/           # electron-builder 打包输出
├── index.html               # HTML 入口
├── package.json             # 项目配置 & 构建脚本
├── vite.config.cjs          # Vite 配置
├── tailwind.config.cjs      # TailwindCSS 配置
└── postcss.config.cjs       # PostCSS 配置
```

## 技术栈

| 技术 | 用途 | 版本 |
|------|------|------|
| [Electron](https://electronjs.org/) | 桌面应用框架 | 29.x |
| [React](https://react.dev/) | UI 渲染 | 18.x |
| [Vite](https://vitejs.dev/) | 前端构建工具 | 5.x |
| [TailwindCSS](https://tailwindcss.com/) | CSS 工具类 | 3.x |
| [Framer Motion](https://www.framer.com/motion/) | 动画库 | 11.x |
| [electron-builder](https://electron-builder.com/) | 应用打包 | 24.x |

## 开发指南

### 环境要求

- Node.js >= 16
- npm >= 8
- Windows 10/11

### 安装依赖

```bash
cd clipboard-manager
npm install
```

### 开发模式

```bash
# 启动开发服务器（前端热重载 + Electron）
npm run dev

# 或分别启动：
# 终端1：前端开发服务器
npm run dev:renderer

# 终端2：Electron 主进程
npm start
```

### 构建

```bash
# 构建前端
npm run build

# 打包 Windows 安装程序
npm run pack
```

构建产物位于 `dist-electron/` 目录，生成 `ClipMate Setup 1.0.0.exe` 安装包。

## 数据存储

所有数据存放在 `%APPDATA%/clipmate/` 下：

| 文件 / 目录 | 说明 |
|-------------|------|
| `clipboard-history.json` | 剪贴板历史 + 固定项（JSON，图片仅存路径引用） |
| `settings.json` | 用户设置（布局模式、最大条数等） |
| `images/{id}.png` | 图片文件存储（PNG 格式，独立于 JSON） |
| `debug.log` | 运行日志（启动时清空，运行中上限 512KB 自旋转） |

> `%APPDATA%` 通常为 `C:\Users\<用户名>\AppData\Roaming\clipmate\`

### 图片存储策略

| 策略 | 参数 | 说明 |
|------|------|------|
| 过期清理 | 7 天 | 超过 7 天的图片自动删除 |
| 容量上限 | 200 MB | 超限时从最旧开始删除 |
| 孤儿回收 | 每 6 小时 | 清理无对应记录的废弃图片文件 |
| 去重方式 | MD5 指纹 | 取前 4KB + 文件大小做 hash，避免重复存储 |

## 设计细节

### V5 图片文件化架构

```
复制图片 → NativeImage.toPNG() → 写入 images/{timestamp}.png
                                    ↓
                    JSON 仅存 { imagePath: ".../xxx.png" }
                                    ↓
              渲染进程 <img src="file:///.../xxx.png"> 直接读取
                                    ↓
              粘贴时 nativeImage.createFromPath() 从文件恢复
```

**核心优势**：
- 内存占用：base64 (~2-5MB/张) → 路径引用 (~100B)，降低 ~99%
- JSON 文件体积：从数十 MB 降至几 KB
- 轮询性能：O(n) 字符串比较 → O(1) MD5 指纹比对
- 渲染性能：LazyImage 懒加载 + file:// 协议直接读取，零 IPC 内存拷贝

### 布局模式对比

| 属性 | 底部模式 (`bottom`) | 右侧模式 (`right`) |
|------|---------------------|---------------------|
| 窗口尺寸 | 自适应宽度 x 380px | 360px x 自适应高度 |
| 屏幕位置 | 底部居中偏上 | 右侧边缘 |
| 卡片排列 | 横向滚动 | 垂直列表 |
| 单卡片尺寸 | 自适应（竖向） | 自适应宽度（横向） |
| 文字截断 | 多行预览 | 3 行 |
| 键盘导航 | `←` `→` | `↑` `↓` |

### IPC 通信接口

渲染进程通过 `contextBridge` 安全暴露的 API：

```javascript
// 数据获取
window.clipboardAPI.getHistory()           // 获取剪贴板历史（图片含 file:// URL）
window.clipboardAPI.getItemContent(id)     // 获取完整内容（图片返回 DataURL）
window.clipboardAPI.getImageUrl(id)        // 获取图片 file:// URL

// 操作
window.clipboardAPI.pasteItem(item)        // 粘贴并隐藏窗口
window.clipboardAPI.copyItem(item)         // 复制到剪贴板
window.clipboardAPI.pinItem(id)            // 切换固定状态
window.clipboardAPI.deleteItem(id)         // 删除记录（联动删除图片文件）

// 管理
window.clipboardAPI.clearHistory()         // 清空所有历史（联动删除全部图片）
window.clipboardAPI.hideWindow()           // 隐藏窗口
window.clipboardAPI.getSettings()          // 获取用户设置
window.clipboardAPI.saveSettings(s)        // 保存用户设置

// 事件监听
window.clipboardAPI.onHistoryUpdated(cb)   // 历史更新回调
window.clipboardAPI.onWindowShown(cb)      // 窗口显示回调（接收完整数据）
```

## 已知限制

- 图片粘贴依赖 PowerShell `SendKeys('^v')` 模拟 Ctrl+V，部分特殊输入框（如虚拟机、远程桌面）可能不兼容
- 当前仅支持 Windows 平台
- `webSecurity: false` 用于加载本地 `file://` 图片，不影响安全性（仅加载应用自身目录下的图片）

## License

[MIT](LICENSE.txt)

---

<p align="center">
  Made with ❤️ by <strong>ClipMate</strong>
</p>

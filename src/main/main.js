const { app, BrowserWindow, clipboard, globalShortcut, Tray, Menu, ipcMain, nativeImage, screen, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// Squirrel 安装/卸载事件
if (require('electron-squirrel-startup')) app.quit()

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// 版本号：打包后从 package.json 读取，开发模式尝试 git describe
const appVersion = (() => {
  try {
    return require('../../package.json').version
  } catch (_) {
    return '0.0.0-dev'
  }
})()

let mainWindow = null
let tray = null
let isVisible = false
let blurTimer = null

// ─── 日志 ──────────────────────────────────────────────────────

const LOG_PATH = path.join(app.getPath('userData'), 'debug.log')
const MAX_LOG_SIZE_BYTES = 512 * 1024   // 日志文件上限 512KB，超了就截断
function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}\n`, 'utf-8')
    // 超限截断：保留最后 256KB（从中间切掉旧日志）
    try {
      const stat = fs.statSync(LOG_PATH)
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const content = fs.readFileSync(LOG_PATH, 'utf-8')
        fs.writeFileSync(LOG_PATH, content.slice(-256 * 1024), 'utf-8')
      }
    } catch (_) {}
  } catch (_) {}
}
try { fs.writeFileSync(LOG_PATH, '', 'utf-8') } catch (_) {}
log('=== ClipMate V5 启动（图片文件化存储 + 日志自旋转）===')

// ─── 异常保护 ──────────────────────────────────────────────────

process.on('uncaughtException', (err) => log(`FATAL: ${err.message}\n${err.stack?.slice(0, 500)}`))
process.on('unhandledRejection', (r) => log(`UNHANDLED REJECTION: ${r}`))

// ─── 图片文件存储系统 ─────────────────────────────────────────

const IMAGES_DIR = path.join(app.getPath('userData'), 'images')
const MAX_IMAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000   // 图片保留 7 天
const MAX_IMAGES_TOTAL_SIZE_MB = 200                // 图片总大小上限 200MB
const MAX_IN_MEMORY_IMAGES = 5                       // 内存中最多缓存 5 张图片的 DataURL

/**
 * 确保图片目录存在
 */
function ensureImagesDir() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true })
    log(`创建图片目录: ${IMAGES_DIR}`)
  }
}

/**
 * 将 NativeImage 保存为 PNG 文件，返回文件路径
 * @param {Electron.NativeImage} img - Electron NativeImage 对象
 * @param {number|string} itemId - 剪贴板项 ID
 * @returns {string|null} 保存后的文件路径，失败返回 null
 */
function saveImageToFile(img, itemId) {
  try {
    ensureImagesDir()
    const filePath = path.join(IMAGES_DIR, `${itemId}.png`)
    const buffer = img.toPNG()
    fs.writeFileSync(filePath, buffer)
    log(`图片已保存: ${itemId}.png (${(buffer.length / 1024).toFixed(1)}KB)`)
    return filePath
  } catch (e) {
    log(`保存图片失败: ${e.message}`)
    return null
  }
}

/**
 * 从文件加载图片为 DataURL（按需调用，不常驻内存）
 * @param {string} filePath - 图片文件路径
 * @returns {string|null} DataURL 或 null
 */
function loadImageAsDataURL(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    return img.toDataURL()
  } catch (e) {
    log(`读取图片失败: ${e.message}`)
    return null
  }
}

/**
 * 获取图片文件的 file:// 协议 URL（渲染进程直接用 <img src> 加载）
 * @param {string} filePath - 本地文件路径
 * @returns {string|null}
 */
function getImageFileUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  // Windows 下需要额外编码处理
  let url = filePath.replace(/\\/g, '/')
  if (!url.startsWith('/')) url = '/' + url
  return 'file://' + url
}

// ─── 防抖写入 ──────────────────────────────────────────────

let saveHistoryTimer = null
let saveHistoryPending = false

function scheduleSaveHistory() {
  if (saveHistoryPending) return  // 已经有待执行的写入，不重复调度
  saveHistoryPending = true
  // 防抖 800ms：连续快速复制时合并为一次写入，但最多延迟 800ms
  saveHistoryTimer = setTimeout(() => {
    saveHistoryPending = false
    saveHistory()
  }, 800)
}

// 立即保存（退出等场景需要）
function flushSaveHistory() {
  if (saveHistoryTimer) { clearTimeout(saveHistoryTimer); saveHistoryTimer = null }
  saveHistoryPending = false
  saveHistory()
}

/**
 * 清理不再被引用的孤儿图片文件
 * @param {Set<string>} keepIds - 需要保留的图片 ID 集合
 */
function cleanupOrphanedImages(keepIds) {
  try {
    ensureImagesDir()
    const files = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png'))
    const keepNames = new Set([...keepIds].map(id => `${id}.png`))
    let removed = 0
    for (const f of files) {
      if (!keepNames.has(f)) {
        const fullPath = path.join(IMAGES_DIR, f)
        try {
          fs.unlinkSync(fullPath)
          removed++
        } catch (_) {}
      }
    }
    if (removed > 0) log(`清理了 ${removed} 个孤儿图片文件`)
  } catch (e) { log(`清理孤儿图片出错: ${e.message}`) }
}

/**
 * 按时间和总大小清理过期图片
 * - 删除超过 MAX_IMAGE_AGE_MS 的旧图片
 * - 如果总大小超过上限，从最旧的开始删除
 */
function cleanupExpiredImages() {
  try {
    ensureImagesDir()
    const now = Date.now()
    const files = fs.readdirSync(IMAGES_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => {
        const fp = path.join(IMAGES_DIR, f)
        try {
          const stat = fs.statSync(fp)
          return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs }
        } catch (_) { return null }
      })
      .filter(Boolean)

    // 1. 删除超时的旧文件
    const expiredFiles = files.filter(f => now - f.mtime > MAX_IMAGE_AGE_MS)
    for (const f of expiredFiles) {
      try { fs.unlinkSync(f.path); log(`清理过期图片: ${f.name}`) } catch (_) {}
    }

    // 2. 计算剩余文件总大小，超限则从最旧开始删
    let remaining = files.filter(f => !expiredFiles.includes(f))
    remaining.sort((a, b) => a.mtime - b.mtime)

    let totalSize = remaining.reduce((s, f) => s + f.size, 0)
    const maxSizeBytes = MAX_IMAGES_TOTAL_SIZE_MB * 1024 * 1024

    while (totalSize > maxSizeBytes && remaining.length > 0) {
      const oldest = remaining.shift()
      try { fs.unlinkSync(oldest.path); totalSize -= oldest.size; log(`清理超容图片: ${oldest.name} (${(oldest.size / 1024).toFixed(1)}KB)`) } catch (_) {}
    }

    const finalCount = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png')).length
    log(`图片清理完成，当前 ${finalCount} 张，总大小约 ${(totalSize / 1024 / 1024).toFixed(1)}MB`)

  } catch (e) { log(`清理过期图片出错: ${e.message}`) }
}

/**
 * 获取所有图片文件的总大小（用于监控）
 */
function getImagesTotalSize() {
  try {
    ensureImagesDir()
    return fs.readdirSync(IMAGES_DIR)
      .filter(f => f.endsWith('.png'))
      .reduce((s, f) => {
        try { return s + fs.statSync(path.join(IMAGES_DIR, f)).size } catch (_) { return s }
      }, 0)
  } catch (_) { return 0 }
}

// ─── 剪贴板数据 ───────────────────────────────────────────────

const DB_PATH = path.join(app.getPath('userData'), 'clipboard-history.json')
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')
let clipboardHistory = []
let pinnedItems = []
let lastClipboardText = ''
let lastClipboardImageHash = null   // 用哈希代替完整 base64 比较
let lastClipboardImageSize = 0       // 用大小做快速预检
let pollingInterval = null

const DEFAULT_SETTINGS = {
  layout: 'bottom',
  maxItems: 200,
  startWithSystem: false,
  showStatusBar: true,
  theme: 'dark',
  skipUpdateVersion: null,
  shortcuts: {
    toggleWindow: 'Ctrl+Shift+V',
    openSettings: 'Ctrl+Comma'
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS }
}
function saveSettings(s) { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8') } catch (_) {} }
let appSettings = loadSettings()

// ─── 数据持久化 ────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
      clipboardHistory = (data.history || []).slice(0, appSettings.maxItems || 200)
      pinnedItems = data.pinned || []
    }
  } catch (_) { clipboardHistory = []; pinnedItems = [] }
}

function saveHistory() {
  try {
    // 存储时：图片只存 filePath 引用，不存 base64 内容 → JSON 极小
    const serializableHistory = clipboardHistory.map(item => ({
      id: item.id,
      type: item.type,
      content: item.type === 'image' ? '' : item.content,        // 图片不存 content
      preview: item.type === 'image' ? '[图片]' : (item.preview || '').slice(0, 300),
      time: item.time,
      pinned: !!item.pinned,
      imagePath: item.imagePath || null                            // 图片存文件路径引用
    }))
    const serializablePinned = pinnedItems.map(item => ({
      id: item.id,
      type: item.type,
      content: item.type === 'image' ? '' : item.content,
      preview: item.type === 'image' ? '[图片]' : (item.preview || '').slice(0, 300),
      time: item.time,
      pinned: true,
      imagePath: item.imagePath || null
    }))
    fs.writeFileSync(DB_PATH, JSON.stringify({ history: serializableHistory, pinned: serializablePinned }, null, 2))
  } catch (_) {}
}

/**
 * 轻量级图片指纹：用位图前 N 字节的 hash 做快速比对
 * 使用 toBitmap() 而非 toPNG()，避免完整 PNG 编码（截图可能 2-5MB）
 */
function getImageFingerprint(img) {
  try {
    // toBitmap 返回原始像素数据（BGRA 格式），无需 PNG 编码开销
    const buf = img.toBitmap()
    const sample = buf.slice(0, 4096)
    return crypto.createHash('md5').update(sample).digest('hex') + `_${buf.length}`
  } catch (_) { return null }
}

function addToHistory(item) {
  // 去重：文字比内容，图片比 ID（因为同图不同 ID 不去重也行，但避免短时间重复添加）
  const existingIdx = clipboardHistory.findIndex(h =>
    h.type === item.type && (
      item.type === 'text' ? h.content === item.content : h.id === item.id
    )
  )
  if (existingIdx !== -1) clipboardHistory.splice(existingIdx, 1)
  clipboardHistory.unshift(item)
  const max = appSettings.maxItems || 200
  if (clipboardHistory.length > max) clipboardHistory = clipboardHistory.slice(0, max)

  // ★ 防抖写入：不再每次都同步写磁盘
  scheduleSaveHistory()

  // ★ 窗口可见时才发送 IPC 更新（隐藏状态不发，避免无谓渲染）
  if (isVisible) {
    safeSend('history-updated', slimData(clipboardHistory))
  }
}

/**
 * 裁剪发送给渲染进程的数据：
 * - 图片类型：不传 base64 content，传 file:// URL 让浏览器直接从磁盘加载
 * - 其他字段正常传递
 */
function slimData(items) {
  return items.map(item => ({
    id: item.id,
    type: item.type,
    content: item.type === 'image' ? '' : item.content,
    preview: item.type === 'image' ? '[图片]' : (item.preview || '').slice(0, 300),
    time: item.time,
    pinned: !!item.pinned,
    imageUrl: item.type === 'image' && item.imagePath ? getImageFileUrl(item.imagePath) : null
  }))
}

// 安全发送
function safeSend(ch, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(ch, ...args)
    }
  } catch (_) {}
}

// ─── 剪贴板监听 ────────────────────────────────────────────────

function startClipboardPolling() {
  lastClipboardText = clipboard.readText()
  // 启动时也初始化图片状态，避免首次进入图片分支时误判
  const startupImage = clipboard.readImage()
  if (!startupImage.isEmpty()) {
    const sz = startupImage.getSize()
    lastClipboardImageHash = `${sz.width}x${sz.height}`
    lastClipboardImageSize = sz.width * sz.height
    const fp = getImageFingerprint(startupImage)
    if (fp) lastClipboardImageHash = fp
  }

  pollingInterval = setInterval(() => {
    try {
      // ★ 优化1：先读文字（极轻量），有变化直接处理
      const currentText = clipboard.readText()
      if (currentText && currentText !== lastClipboardText) {
        lastClipboardText = currentText
        // 清除之前的图片指纹（文字覆盖了图片）
        lastClipboardImageHash = null
        lastClipboardImageSize = 0

        addToHistory({
          id: Date.now(),
          type: 'text',
          content: currentText,
          preview: currentText.slice(0, 300),
          time: new Date().toISOString(),
          pinned: false
        })
        return  // 文字分支结束，不再检查图片
      }

      // ★ 优化2：文字没变化时，才考虑图片（减少 ~50% 的 readImage 调用）
      // 注意：不要求 !currentText，因为截图工具可能同时写入文字和图片
      if (currentText === lastClipboardText) {
        const currentImage = clipboard.readImage()
        if (!currentImage.isEmpty()) {
          const imgSize = currentImage.getSize()
          const quickKey = `${imgSize.width}x${imgSize.height}`

          if (quickKey !== lastClipboardImageHash) {
            const fingerprint = getImageFingerprint(currentImage)
            if (fingerprint && fingerprint !== lastClipboardImageHash) {
              lastClipboardImageHash = fingerprint
              lastClipboardImageSize = imgSize.width * imgSize.height

              const itemId = Date.now()
              const filePath = saveImageToFile(currentImage, itemId)

              addToHistory({
                id: itemId,
                type: 'image',
                content: '',
                preview: '[图片]',
                time: new Date().toISOString(),
                pinned: false,
                imagePath: filePath
              })

              log(`新图片捕获: ${imgSize.width}x${imgSize.height} → ${filePath ? '文件已保存' : '保存失败'}`)
            }
          }
        }
      }
    } catch (e) { log(`轮询错误: ${e.message}`) }
  }, 500)
}

// ─── 窗口管理 ──────────────────────────────────────────────────

function getIconPath() { return isDev ? path.join(__dirname, '../../assets/icon.ico') : path.join(process.resourcesPath, 'assets', 'icon.ico') }
function getTrayIconPath() { return isDev ? path.join(__dirname, '../../assets/tray-icon.png') : path.join(process.resourcesPath, 'assets', 'tray-icon.png') }

/**
 * 根据当前布局设置计算窗口位置和尺寸
 * @param {object} [settings] - 设置对象，默认使用 appSettings
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function getWindowBounds(settings) {
  const s = settings || appSettings
  const sw = screen.getPrimaryDisplay().workAreaSize
  const isR = s.layout === 'right'
  const w = isR ? 360 : Math.min(sw.width - 40, 1400)
  const h = isR ? Math.min(sw.height - 80, 900) : 380
  const x = isR ? sw.width - w - 8 : Math.round((sw.width - w) / 2)
  const y = isR ? Math.round((sw.height - h) / 2) : Math.round(sw.height - h - 10)
  return { x, y, width: w, height: h }
}

// ─── 版本检查 ──────────────────────────────────────────────────

const https = require('https')
const GITHUB_REPO = 'WinterChenS/Clipmate-windows'  // GitHub 仓库（用于 API 查询 tag）
const CHECK_TIMEOUT_MS = 8000                    // 网络请求超时 8 秒
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000   // 自动检查间隔 24 小时

/**
 * 比较两个 semver 版本号：a > b 返回 1，a < b 返回 -1，相等返回 0
 */
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

/**
 * 从 GitHub API 获取最新 tag，返回最新版本号
 * 支持 301/302 重定向跟随，网络异常/超时/解析失败均静默返回 null
 */
function fetchLatestVersion(redirectCount = 0) {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=10`
    const req = https.get(url, {
      headers: { 'User-Agent': 'ClipMate-UpdateCheck' },
      timeout: CHECK_TIMEOUT_MS
    }, (res) => {
      // 跟随 301/302 重定向（仓库改名时 GitHub API 会返回 301）
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectCount < 3) {
        log(`版本检查: 跟随重定向 → ${res.headers.location}`)
        fetchLatestVersionFromUrl(res.headers.location, redirectCount + 1).then(resolve)
        return
      }
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const tags = JSON.parse(body)
          if (!Array.isArray(tags) || tags.length === 0) {
            log(`版本检查: 无 tag 数据`)
            resolve(null)
            return
          }
          // 找到语义版本格式的最新 tag
          const semverTags = tags
            .map(t => t.name)
            .filter(n => /^v?\d+\.\d+\.\d+$/.test(n))
            .sort((a, b) => compareSemver(b, a))
          const latest = semverTags[0]
          if (latest) {
            log(`版本检查: 最新 tag = ${latest}，当前 = v${appVersion}`)
          }
          resolve(latest || null)
        } catch (e) {
          log(`版本检查: 解析响应失败 - ${e.message}`)
          resolve(null)
        }
      })
    })
    req.on('error', (e) => {
      log(`版本检查: 网络错误 - ${e.message}`)
      resolve(null)
    })
    req.on('timeout', () => {
      log(`版本检查: 请求超时 (${CHECK_TIMEOUT_MS}ms)`)
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * 从指定 URL 获取最新 tag（用于跟随重定向）
 */
function fetchLatestVersionFromUrl(redirectUrl, redirectCount) {
  return new Promise((resolve) => {
    const req = https.get(redirectUrl, {
      headers: { 'User-Agent': 'ClipMate-UpdateCheck' },
      timeout: CHECK_TIMEOUT_MS
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectCount < 3) {
        log(`版本检查: 跟随重定向 → ${res.headers.location}`)
        fetchLatestVersionFromUrl(res.headers.location, redirectCount + 1).then(resolve)
        return
      }
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const tags = JSON.parse(body)
          if (!Array.isArray(tags) || tags.length === 0) {
            log(`版本检查: 无 tag 数据`)
            resolve(null)
            return
          }
          const semverTags = tags
            .map(t => t.name)
            .filter(n => /^v?\d+\.\d+\.\d+$/.test(n))
            .sort((a, b) => compareSemver(b, a))
          const latest = semverTags[0]
          if (latest) {
            log(`版本检查: 最新 tag = ${latest}，当前 = v${appVersion}`)
          }
          resolve(latest || null)
        } catch (e) {
          log(`版本检查: 解析响应失败 - ${e.message}`)
          resolve(null)
        }
      })
    })
    req.on('error', (e) => {
      log(`版本检查: 网络错误 - ${e.message}`)
      resolve(null)
    })
    req.on('timeout', () => {
      log(`版本检查: 请求超时 (${CHECK_TIMEOUT_MS}ms)`)
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * 执行版本检查，如果有新版本则通知渲染进程
 * @param {boolean} isManual - 是否手动触发（手动触发时即使 skipUpdateVersion 也显示）
 */
async function checkForUpdate(isManual = false) {
  log(`版本检查: ${isManual ? '手动' : '自动'}触发`)
  const latestTag = await fetchLatestVersion()
  if (!latestTag) {
    if (isManual) safeSend('update-check-result', { available: false, error: true, message: '网络连接失败，请稍后再试' })
    return
  }

  const latestVersion = latestTag.replace(/^v/, '')
  const hasUpdate = compareSemver(latestVersion, appVersion) > 0

  if (!hasUpdate) {
    log(`版本检查: 已是最新版本 v${appVersion}`)
    safeSend('update-check-result', { available: false, currentVersion: appVersion, latestVersion })
    return
  }

  // 检查用户是否跳过了此版本
  const skipVersion = appSettings.skipUpdateVersion
  if (!isManual && skipVersion === latestVersion) {
    log(`版本检查: 用户已跳过 v${latestVersion}，不再提示`)
    return
  }

  log(`版本检查: 发现新版本 v${latestVersion}`)
  safeSend('update-check-result', {
    available: true,
    currentVersion: appVersion,
    latestVersion,
    downloadUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${latestTag}`
  })
}

function createWindow() {
  const { x, y, width: w, height: h } = getWindowBounds()

  log(`createWindow: ${w}x${h} at (${x},${y})`)

  mainWindow = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      webSecurity: false           // 允许加载本地 file:// 图片
    }
  })

  // ★ 核心：拦截 close 事件，阻止窗口被销毁
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      log(`close → 拦截并隐藏`)
      e.preventDefault()
      doHide('intercepted-close')
    } else {
      log(`close → 允许退出`)
    }
  })

  // 加载页面
  const loadPromise = isDev
    ? mainWindow.loadURL('http://localhost:5173').catch(e => log(`loadURL失败: ${e.message}`))
    : mainWindow.loadFile(path.join(__dirname, '../../dist/index.html')).catch(e => log(`loadFile失败: ${e.message}`))

  // 渲染进程崩溃恢复
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程崩溃! reason=${details.reason}`)
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      log('重新加载页面...')
      const p = isDev
        ? mainWindow.loadURL('http://localhost:5173')
        : mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
      p.catch(_ => {})
    }, 1000)
  })

  // blur 防抖 + 光标检查
  mainWindow.on('blur', () => {
    if (!isVisible) return
    log('blur')
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      if (!isVisible || !mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isFocused()) return

      // 光标在窗口内则重新聚焦
      const cur = screen.getCursorScreenPoint()
      const b = mainWindow.getBounds()
      if (cur.x >= b.x && cur.x <= b.x + b.width && cur.y >= b.y && cur.y <= b.y + b.height) {
        try { mainWindow.focus() } catch (_) {}
        return
      }

      doHide('blur-check')
    }, 300)
  })
  mainWindow.on('focus', () => { if (blurTimer) { clearTimeout(blurTimer); blurTimer = null } })
  mainWindow.on('closed', () => { log('closed!'); isVisible = false; cancelBlur() })
}

function doHide(reason = '?') {
  log(`hide[${reason}]`); cancelBlur(); isVisible = false
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide() } catch (_) {}
}

function showWindow(source = 'unknown') {
  log(`show[${source}]`); cancelBlur()

  // 重建窗口
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('重建窗口'); createWindow()
  }

  // 等待就绪
  const tryShow = (retries = 0) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (retries < 15) { setTimeout(() => tryShow(retries + 1), 50); return }
      log('show失败: 窗口不可用'); return
    }
    try {
      appSettings = loadSettings()
      const bounds = getWindowBounds()
      mainWindow.setBounds(bounds)
      mainWindow.show()
      mainWindow.focus()
      isVisible = true

      // ★ 发送数据（图片以 file:// URL 形式，几乎零内存开销）
      safeSend('window-shown', {
        history: slimData(clipboardHistory),
        pinned: slimData(pinnedItems),
        settings: appSettings,
        version: appVersion
      })

      log(`show完成 focused=${mainWindow.isFocused()}`)
      // Windows focus 补偿
      setTimeout(() => { if (isVisible && mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.focus() } catch(_) {} } }, 100)
      setTimeout(() => { if (isVisible && mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.setAlwaysOnTop(true); mainWindow.focus() } catch(_) {} } }, 300)
    } catch (e) { log(`show异常: ${e.message}`) }
  }
  tryShow()
}

function toggleWindow(src = '?') {
  log(`toggle[${src}] vis=${isVisible}`)
  isVisible ? doHide('toggle') : showWindow(src)
}
function cancelBlur() { if (blurTimer) { clearTimeout(blurTimer); blurTimer = null } }

// ─── 托盘 ──────────────────────────────────────────────────────

function createTray() {
  const tp = getTrayIconPath()
  tray = new Tray(fs.existsSync(tp) ? nativeImage.createFromPath(tp) : nativeImage.createEmpty())
  tray.setToolTip(`ClipMate v${appVersion} - 剪贴板管理器`)
  updateTrayMenu()
  tray.on('click', () => toggleWindow('tray'))
}
function updateTrayMenu() {
  if (!tray) return
  const ls = app.getLoginItemSettings()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示/隐藏  ${appSettings.shortcuts?.toggleWindow || 'Ctrl+Shift+V'}`, click: () => toggleWindow('menu') },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: ls.openAtLogin, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked }); updateTrayMenu() } },
    { type: 'separator' },
    { label: '清空历史记录', click: () => clearAllData() },
    { type: 'separator' },
    { label: '退出 ClipMate', click: () => { log('用户退出'); app.isQuiting = true; app.quit() } }
  ]))
}

// ─── 全局快捷键（动态注册） ──────────────────────────────────

let currentToggleAccelerator = null

/**
 * 注册/更新全局显示隐藏快捷键
 * @param {string} accelerator - 如 'Ctrl+Shift+V'
 */
function registerToggleShortcut(accelerator) {
  // 先注销旧的
  if (currentToggleAccelerator) {
    try { globalShortcut.unregister(currentToggleAccelerator) } catch (_) {}
    currentToggleAccelerator = null
  }
  if (!accelerator || !accelerator.trim()) return
  const ok = globalShortcut.register(accelerator, () => toggleWindow('hotkey'))
  if (ok) {
    currentToggleAccelerator = accelerator
    log(`全局快捷键已注册: ${accelerator}`)
  } else {
    log(`全局快捷键注册失败: ${accelerator}，回退到默认`)
    // 回退到默认值
    if (accelerator !== 'Ctrl+Shift+V') {
      registerToggleShortcut('Ctrl+Shift+V')
    }
  }
}

ipcMain.handle('get-history', () => ({ history: slimData(clipboardHistory), pinned: slimData(pinnedItems) }))

/**
 * 渲染进程请求获取完整内容
 * - 文字：直接返回 content
 * - 图片：从文件加载为 DataURL（按需，不缓存）
 */
ipcMain.handle('get-item-content', (_event, itemId) => {
  const all = [...pinnedItems, ...clipboardHistory]
  const item = all.find(i => i.id === itemId)
  if (!item) return null

  if (item.type === 'image') {
    // 从本地文件加载，返回 DataURL 用于粘贴操作
    const dataUrl = loadImageAsDataURL(item.imagePath)
    return dataUrl ? { content: dataUrl, type: 'image', preview: '[图片]', hasLocalFile: true } : { content: null, type: 'image', preview: '[图片]', hasLocalFile: false }
  }
  return { content: item.content, type: item.type, preview: item.preview, hasLocalFile: false }
})

/**
 * 渲染进程请求图片的 file:// URL（用于 <img src> 直接显示缩略图）
 */
ipcMain.handle('get-image-url', (_event, itemId) => {
  const all = [...pinnedItems, ...clipboardHistory]
  const item = all.find(i => i.id === itemId)
  if (!item || item.type !== 'image' || !item.imagePath) return null
  return getImageFileUrl(item.imagePath)
})

ipcMain.handle('paste-item', (event, item) => {
  try {
    // 图片：从本地文件加载完整数据写入剪贴板
    if (item.type === 'image') {
      const all = [...pinnedItems, ...clipboardHistory]
      const found = all.find(i => i.id === item.id)
      if (found && found.imagePath && fs.existsSync(found.imagePath)) {
        const img = nativeImage.createFromPath(found.imagePath)
        if (!img.isEmpty()) clipboard.writeImage(img)
      } else if (item.content) {
        // 回退：如果有 base64 content 则使用
        const img = nativeImage.createFromDataURL(item.content)
        if (!img.isEmpty()) clipboard.writeImage(img)
      }
    } else {
      clipboard.writeText(item.content)
    }
  } catch (e) { log(`paste错: ${e.message}`) }
  doHide('paste')
  setTimeout(() => { try { require('child_process').execSync('powershell -c "$w=New-Object -ComObject WScript.Shell;$w.SendKeys(\'^v\')"') } catch(_) {} }, 200)
  return true
})

ipcMain.handle('copy-item', (event, item) => {
  try {
    if (item.type === 'image') {
      const all = [...pinnedItems, ...clipboardHistory]
      const found = all.find(i => i.id === item.id)
      if (found && found.imagePath && fs.existsSync(found.imagePath)) {
        const img = nativeImage.createFromPath(found.imagePath)
        if (!img.isEmpty()) clipboard.writeImage(img)
      } else if (item.content) {
        const img = nativeImage.createFromDataURL(item.content)
        if (!img.isEmpty()) clipboard.writeImage(img)
      }
    } else {
      clipboard.writeText(item.content)
    }
  } catch (e) { log(`copy错: ${e.message}`) }
  doHide('copy')
  return true
})

ipcMain.handle('pin-item', (event, itemId) => {
  const idx = clipboardHistory.findIndex(h => h.id === itemId)
  if (idx !== -1) {
    clipboardHistory[idx].pinned = !clipboardHistory[idx].pinned
    const item = clipboardHistory[idx]
    if (item.pinned) { pinnedItems = pinnedItems.filter(p => p.id !== itemId); pinnedItems.unshift({ ...item }) }
    else { pinnedItems = pinnedItems.filter(p => p.id !== itemId) }
    saveHistory()
    return { history: slimData(clipboardHistory), pinned: slimData(pinnedItems) }
  }
  return null
})
ipcMain.handle('delete-item', (event, itemId) => {
  // 删除时同时清理对应的图片文件
  const item = [...clipboardHistory, ...pinnedItems].find(i => i.id === itemId)
  if (item?.type === 'image' && item.imagePath) {
    try { fs.unlinkSync(item.imagePath); log(`删除图片文件: ${item.imagePath}`) } catch (_) {}
  }
  clipboardHistory = clipboardHistory.filter(h => h.id !== itemId)
  pinnedItems = pinnedItems.filter(p => p.id !== itemId)
  saveHistory()
  return { history: slimData(clipboardHistory), pinned: slimData(pinnedItems) }
})
ipcMain.handle('clear-history', () => { clearAllData(); return { history: [], pinned: [] } })
ipcMain.handle('hide-window', () => doHide('esc'))
ipcMain.handle('get-settings', () => ({ ...appSettings, version: appVersion }))
ipcMain.handle('save-settings', (event, ns) => {
  appSettings = { ...appSettings, ...ns }; saveSettings(appSettings)
  // ★ 快捷键变更时动态重注册全局热键 + 更新托盘菜单
  if (ns.shortcuts?.toggleWindow) {
    registerToggleShortcut(ns.shortcuts.toggleWindow)
    updateTrayMenu()
  }
  if (ns.layout && mainWindow && !mainWindow.isDestroyed() && isVisible) {
    try { mainWindow.setBounds(getWindowBounds()) } catch(_) {}
  }
  return appSettings
})
ipcMain.handle('set-autostart', (event, e) => { app.setLoginItemSettings({ openAtLogin: e }); updateTrayMenu(); return e })

// 版本检查 IPC
ipcMain.handle('check-for-update', async () => {
  await checkForUpdate(true)   // 手动触发
  return true
})
ipcMain.handle('skip-update-version', (event, version) => {
  appSettings.skipUpdateVersion = version
  saveSettings(appSettings)
  log(`用户跳过版本更新提示: v${version}`)
  return true
})

/**
 * 清空全部数据（历史 + 固定 + 图片文件）
 */
function clearAllData() {
  clipboardHistory = []
  pinnedItems = []
  // 清空图片目录
  try {
    ensureImagesDir()
    const files = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png'))
    for (const f of files) {
      try { fs.unlinkSync(path.join(IMAGES_DIR, f)) } catch (_) {}
    }
    log(`清空 ${files.length} 个图片文件`)
  } catch (_) {}
  saveHistory()
  safeSend('history-updated', [])
}

// ═══ 生命周期 ════════════════════════════════════════════════════

app.whenReady().then(() => {
  log('ready')
  const lock = app.requestSingleInstanceLock()
  if (!lock) { log('已有实例'); app.quit(); return }
  app.on('second-instance', () => toggleWindow('second'))

  // ★ 启动时执行一次全面清理
  ensureImagesDir()
  cleanupExpiredImages()

  loadHistory()
  createWindow()
  createTray()
  startClipboardPolling()

  registerToggleShortcut(appSettings.shortcuts?.toggleWindow || 'Ctrl+Shift+V')

  // ★ 启动后延迟 5 秒自动检查版本更新（静默，网络异常不影响使用）
  setTimeout(() => checkForUpdate(false), 5000)
  // 每天再检查一次
  setInterval(() => checkForUpdate(false), CHECK_INTERVAL_MS)

  // 定期清理（每 6 小时）
  setInterval(() => {
    cleanupExpiredImages()
    // 收集当前所有活跃图片 ID，清理孤儿
    const activeIds = new Set([
      ...clipboardHistory.filter(i => i.type === 'image').map(i => i.id),
      ...pinnedItems.filter(i => i.type === 'image').map(i => i.id)
    ])
    cleanupOrphanedImages(activeIds)
  }, 6 * 60 * 60 * 1000)

  log(`图片目录初始化完成，当前占用 ${(getImagesTotalSize() / 1024 / 1024).toFixed(1)}MB`)
})
app.on('window-all-closed', (e) => { if (!app.isQuiting) e.preventDefault() })
app.on('before-quit', () => { log('before-quit'); app.isQuiting = true; flushSaveHistory() })
app.on('will-quit', () => { log('will-quit'); globalShortcut.unregisterAll(); if (pollingInterval) clearInterval(pollingInterval); cancelBlur() })

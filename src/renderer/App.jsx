import React, { useState, useEffect, useRef, useCallback } from 'react'

// ─── 工具函数 ─────────────────────────────────────────────

function formatTime(isoString) {
  const date = new Date(isoString)
  const now = new Date()
  const diff = now - date

  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 8640000) return `${Math.floor(diff / 3600000)} 小时前`

  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${month}/${day} ${hour}:${min}`
}

function isUrl(text) {
  return /^https?:\/\//i.test(text.trim())
}

function getItemType(item) {
  if (item.type === 'image') return 'image'
  if (item.type === 'text' && isUrl(item.content)) return 'link'
  return 'text'
}

// ─── 图片缩略图组件（懒加载 + 错误处理） ──────────────────
// 使用 file:// URL 直接从磁盘加载，不经过 IPC，零内存开销

function LazyImage({ src, alt, className, placeholderClass }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [imgSrc, setImgSrc] = useState(src)

  // 当外部 src 变化时重置状态
  useEffect(() => {
    setLoaded(false)
    setError(false)
    setImgSrc(src)
  }, [src])

  if (!src || error) {
    return <div className={placeholderClass || `${className} ${className}-placeholder`}>🖼</div>
  }

  return (
    <img
      src={imgSrc}
      alt={alt || '图片'}
      className={`${className}${loaded ? ' loaded' : ' loading'}`}
      draggable={false}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      onError={() => setError(true)}
      style={{ opacity: loaded ? 1 : 0.3 }}
    />
  )
}

// ─── 底部布局：横向卡片（仿 macOS Paste） ──────────────────

function BottomCard({ item, isSelected, onSelect, onPaste, onPin, onDelete, delay = 0 }) {
  const type = getItemType(item)
  return (
    <div
      className={`clip-card bottom-card ${isSelected ? 'selected' : ''} ${item.pinned ? 'pinned-badge' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onPaste(item)}
    >
      <div className="card-actions">
        <button className="action-btn pin" title={item.pinned ? '取消固定' : '固定'}
          onClick={(e) => { e.stopPropagation(); onPin(item.id) }}>
          {item.pinned ? '★' : '☆'}
        </button>
        <button className="action-btn danger" title="删除"
          onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}>✕</button>
      </div>
      <div className="card-content">
        {type === 'image'
          ? <LazyImage
              src={item.imageUrl}
              alt="图片"
              className="card-image"
              placeholderClass="card-image-placeholder"
            />
          : <div className="card-text">{item.preview || item.content}</div>
        }
      </div>
      <div className="card-footer">
        <span className="card-time">{formatTime(item.time)}</span>
        <span className={`card-type-badge ${type}`}>
          {type === 'text' ? '文字' : type === 'image' ? '图片' : '链接'}
        </span>
      </div>
    </div>
  )
}

// ─── 右侧布局：垂直列表卡片 ────────────────────────────────

function RightCard({ item, isSelected, onSelect, onPaste, onPin, onDelete, index = 0 }) {
  const type = getItemType(item)
  return (
    <div
      className={`clip-card right-card ${isSelected ? 'selected' : ''} ${item.pinned ? 'pinned-badge' : ''}`}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onPaste(item)}
    >
      <div className="right-card-main">
        {type === 'image' ? (
          <LazyImage
            src={item.imageUrl}
            alt="图片"
            className="right-card-image"
            placeholderClass="right-card-image-placeholder"
          />
        ) : (
          <div className="right-card-text">{item.preview || item.content}</div>
        )}
      </div>
      <div className="right-card-meta">
        <span className="card-time">{formatTime(item.time)}</span>
        <span className={`card-type-badge ${type}`}>
          {type === 'text' ? '文字' : type === 'image' ? '图片' : '链接'}
        </span>
        <div className="right-card-actions">
          <button className="action-btn pin" title={item.pinned ? '取消固定' : '固定'}
            onClick={(e) => { e.stopPropagation(); onPin(item.id) }}>
            {item.pinned ? '★' : '☆'}
          </button>
          <button className="action-btn danger" title="删除"
            onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}>✕</button>
        </div>
      </div>
    </div>
  )
}

// ─── 空状态 ──────────────────────────────────────────────

function EmptyState({ message, layout }) {
  return (
    <div className={`empty-state ${layout}-empty`}>
      <div className="empty-icon">📋</div>
      <div className="empty-text">{message || '暂无剪贴板记录\n复制内容后将显示在这里'}</div>
    </div>
  )
}

// ─── Toast ────────────────────────────────────────────────

function Toast({ message, onHide }) {
  const timerRef = useRef(null)
  const hideRef = useRef(onHide)
  hideRef.current = onHide  // 始终保持最新
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { hideRef.current() }, 1500)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [message])  // 仅 message 变化时重启
  return <div className="toast">{message}</div>
}

// ─── 主题工具 ──────────────────────────────────────────────

/** 检测键盘事件是否匹配 Electron Accelerator 格式 */
function matchAccelerator(e, accelerator) {
  if (!accelerator) return false
  const parts = accelerator.split('+').map(s => s.trim().toLowerCase())
  // 检查修饰键
  const hasCtrl = parts.includes('ctrl') || parts.includes('commandorctrl')
  const hasAlt = parts.includes('alt')
  const hasShift = parts.includes('shift')
  const hasCmd = parts.includes('commandorctrl') || (parts.includes('command') || parts.includes('meta'))

  if (hasCtrl && !e.ctrlKey && !e.metaKey) return false
  if (hasAlt && !e.altKey) return false
  if (hasShift && !e.shiftKey) return false
  if ((parts.includes('commandorctrl') || parts.includes('command') || parts.includes('meta')) && !e.metaKey && !e.ctrlKey) return false

  // 检查主键
  const mainKey = parts.find(p =>
    !['ctrl', 'alt', 'shift', 'commandorctrl', 'command', 'meta'].includes(p)
  )
  if (!mainKey) return true  // 纯修饰键组合（如 Ctrl+Alt）

  // 特殊按键映射
  const keyMap = {
    ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash',
    '`': 'backquote', '-': 'minus', '=': 'equal', '[': 'bracketleft',
    ']': 'bracketright', ';': 'semicolon', "'": 'quote',
    'enter': 'enter', 'tab': 'tab', ' ': 'space', 'backspace': 'backspace',
    'delete': 'delete', 'insert': 'insert', 'home': 'home', 'end': 'end',
    'pageup': 'pageup', 'pagedown': 'pagedown',
    'arrowup': 'arrowup', 'arrowdown': 'arrowdown', 'arrowleft': 'arrowleft', 'arrowright': 'arrowright'
  }
  const normalizedKey = e.key.toLowerCase()
  const expectedKey = keyMap[mainKey] || mainKey
  return normalizedKey === expectedKey
}

function getSystemTheme() {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

function applyTheme(theme) {
  if (!document.documentElement) return
  if (theme === 'system') {
    document.documentElement.dataset.theme = getSystemTheme()
  } else {
    document.documentElement.dataset.theme = theme
  }
}

// ─── 快捷键录制器 ────────────────────────────────────────────

/**
 * 按键名称映射（显示用友好名称）
 */
const KEY_NAMES = {
  Control: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  Meta: '⌘', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', Semicolon: ';', Quote: "'", Backspace: '⌫',
  Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', Enter: 'Enter', Tab: 'Tab',
  Space: 'Space'
}

/** 将键盘事件转为 Electron Accelerator 格式 */
function eventToAccelerator(e) {
  const parts = []
  if (e.ctrlKey || e.key === 'Control') parts.push('Ctrl')
  if (e.altKey || e.key === 'Alt') parts.push('Alt')
  if (e.metaKey || e.key === 'Meta') parts.push('CommandOrCtrl')
  if (e.shiftKey || e.key === 'Shift') parts.push('Shift')

  // 提取主键（排除修饰键）
  const mainKey = ['Control', 'Alt', 'Meta', 'Shift'].includes(e.key) ? null : e.key
  if (mainKey) {
    // 单字符按键直接用，特殊键映射
    if (mainKey.length === 1) parts.push(mainKey.toUpperCase())
    else parts.push(mainKey)
  }

  return parts.join('+')
}

/** 将 Accelerator 格式转为显示字符串 */
function acceleratorToDisplay(acc) {
  if (!acc) return ''
  return acc.replace(/CommandOrCtrl/g, '⌘').replace(/\+/g, ' + ')
}

function KeyRecorder({ value, onChange, label, description }) {
  const [recording, setRecording] = useState(false)
  const [currentKeys, setCurrentKeys] = useState('')
  const containerRef = useRef(null)

  const startRecord = () => {
    setRecording(true)
    setCurrentKeys('')
  }

  useEffect(() => {
    if (!recording) return

    const handleKeyDown = (e) => {
      e.preventDefault()
      e.stopPropagation()

      // ESC 取消
      if (e.key === 'Escape') {
        setRecording(false); setCurrentKeys('')
        return
      }

      // 回车/空格确认（如果已有组合）
      const acc = eventToAccelerator(e)
      if ((e.key === 'Enter' || e.key === ' ') && acc) {
        onChange(acc)
        setRecording(false); setCurrentKeys('')
        return
      }

      // 实时显示当前按下的组合
      setCurrentKeys(acceleratorToDisplay(acc))

      // 有有效组合时自动确认（松开时确认不太可靠，这里按下就确认）
      if (acc && !['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) {
        onChange(acc)
        setRecording(false); setCurrentKeys('')
      }
    }

    // 点击外部取消录制
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setRecording(false); setCurrentKeys('')
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('mousedown', handleClickOutside, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [recording, onChange])

  const displayValue = recording ? (currentKeys || '按下快捷键...') : (acceleratorToDisplay(value) || '未设置')

  return (
    <div className="shortcut-row" ref={containerRef}>
      <div className="shortcut-info">
        <span className="shortcut-label">{label}</span>
        {description && <span className="shortcut-desc">{description}</span>}
      </div>
      <button
        className={`shortcut-recorder ${recording ? 'recording' : ''}`}
        onClick={recording ? undefined : startRecord}
        title={recording ? '按 ESC 取消' : '点击修改'}
      >
        {recording && <span className="recording-dot" />}
        <span className="shortcut-display">{displayValue}</span>
        {!recording && <span className="shortcut-edit">✎</span>}
      </button>
    </div>
  )
}

function SettingsPanel({ settings, onSave, onClose }) {
  const [local, setLocal] = useState(settings)

  const handleSave = () => {
    onSave(local)
    onClose()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">⚙ 设置</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          {/* 布局模式 */}
          <div className="setting-group">
            <label className="setting-label">面板位置</label>
            <div className="layout-options">
              <div
                className={`layout-option ${local.layout === 'bottom' ? 'active' : ''}`}
                onClick={() => setLocal(s => ({ ...s, layout: 'bottom' }))}
              >
                <div className="layout-preview bottom-preview">
                  <div className="preview-screen">
                    <div className="preview-bar" />
                  </div>
                </div>
                <span className="layout-name">底部（仿 Paste）</span>
              </div>
              <div
                className={`layout-option ${local.layout === 'right' ? 'active' : ''}`}
                onClick={() => setLocal(s => ({ ...s, layout: 'right' }))}
              >
                <div className="layout-preview right-preview">
                  <div className="preview-screen">
                    <div className="preview-sidebar" />
                  </div>
                </div>
                <span className="layout-name">右侧边栏</span>
              </div>
            </div>
          </div>

          {/* 主题模式 */}
          <div className="setting-group">
            <label className="setting-label">颜色主题</label>
            <div className="theme-options">
              <div
                className={`theme-option ${(local.theme || 'dark') === 'light' ? 'active' : ''}`}
                onClick={() => setLocal(s => ({ ...s, theme: 'light' }))}
              >
                <div className="theme-preview" style={{ background: '#f5f5f7' }}>
                  <span className="theme-dot-light" /><span className="theme-dot-light" /><span className="theme-dot-light" />
                </div>
                <span className="theme-name">白天</span>
              </div>
              <div
                className={`theme-option ${(local.theme || 'dark') === 'dark' ? 'active' : ''}`}
                onClick={() => setLocal(s => ({ ...s, theme: 'dark' }))}
              >
                <div className="theme-preview" style={{ background: '#1a1a24' }}>
                  <span className="theme-dot-dark" /><span className="theme-dot-dark" /><span className="theme-dot-dark" />
                </div>
                <span className="theme-name">夜晚</span>
              </div>
              <div
                className={`theme-option ${(local.theme || 'dark') === 'system' ? 'active' : ''}`}
                onClick={() => setLocal(s => ({ ...s, theme: 'system' }))}
              >
                <div className="theme-preview" style={{ background: 'linear-gradient(135deg, #f5f5f7 50%, #1a1a24 50%)' }}>
                  <span className="theme-dot-system" /><span className="theme-dot-system" /><span className="theme-dot-system" />
                </div>
                <span className="theme-name">跟随系统</span>
              </div>
            </div>
          </div>

          {/* 最大条数 */}
          <div className="setting-group">
            <label className="setting-label">最大记录数</label>
            <div className="setting-row">
              <input
                type="range" min="50" max="500" step="50"
                value={local.maxItems || 200}
                onChange={e => setLocal(s => ({ ...s, maxItems: Number(e.target.value) }))}
                className="setting-slider"
              />
              <span className="setting-value">{local.maxItems || 200} 条</span>
            </div>
          </div>

          {/* 状态栏 */}
          <div className="setting-group">
            <label className="setting-label">显示状态栏</label>
            <div className="toggle-switch" onClick={() => setLocal(s => ({ ...s, showStatusBar: !s.showStatusBar }))}>
              <div className={`toggle-knob ${local.showStatusBar !== false ? 'on' : ''}`} />
            </div>
          </div>

          {/* 快捷键设置 */}
          <div className="setting-group">
            <label className="setting-label">快捷键</label>
            <div className="shortcut-list">
              <KeyRecorder
                label="显示 / 隐藏窗口"
                description="全局快捷键，任何地方可用"
                value={local.shortcuts?.toggleWindow || 'Ctrl+Shift+V'}
                onChange={(val) => setLocal(s => ({
                  ...s,
                  shortcuts: { ...s.shortcuts, toggleWindow: val }
                }))}
              />
              <KeyRecorder
                label="打开设置"
                description="应用内快捷键"
                value={local.shortcuts?.openSettings || 'Ctrl+Comma'}
                onChange={(val) => setLocal(s => ({
                  ...s,
                  shortcuts: { ...s.shortcuts, openSettings: val }
                }))}
              />
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="btn-cancel" onClick={onClose}>取消</button>
          <button className="btn-save" onClick={handleSave}>保存并应用</button>
        </div>
      </div>
    </div>
  )
}

// ─── Mock 数据（开发预览用） ───────────────────────────────

const MOCK_DATA = [
  { id: 1, type: 'text', content: 'Hello World! 这是一段测试文字，用于预览剪贴板管理器的效果。', preview: 'Hello World! 这是一段测试文字，用于预览剪贴板管理器的效果。', time: new Date(Date.now() - 120000).toISOString(), pinned: true },
  { id: 2, type: 'text', content: 'https://github.com/example/clipboard-manager', preview: 'https://github.com/example/clipboard-manager', time: new Date(Date.now() - 300000).toISOString(), pinned: false },
  { id: 3, type: 'text', content: `const clipboardManager = {\n  history: [],\n  addItem(text) {\n    this.history.unshift({ id: Date.now(), content: text });\n  }\n}`, preview: `const clipboardManager = {\n  history: [],\n  addItem(text) {\n    this.history.unshift({ id: Date.now(), content: text });\n  }\n}`, time: new Date(Date.now() - 600000).toISOString(), pinned: false },
  { id: 4, type: 'text', content: 'npm install electron react vite tailwindcss', preview: 'npm install electron react vite tailwindcss', time: new Date(Date.now() - 3600000).toISOString(), pinned: false },
  { id: 5, type: 'text', content: 'SELECT * FROM users WHERE status = 1 ORDER BY created_at DESC LIMIT 20;', preview: 'SELECT * FROM users WHERE status = 1 ORDER BY created_at DESC LIMIT 20;', time: new Date(Date.now() - 86400000).toISOString(), pinned: false },
]

// ════════════════════════════════════════════════════════════
//                         主应用
// ════════════════════════════════════════════════════════════

export default function App() {
  const [history, setHistory] = useState([])
  const [pinned, setPinned] = useState([])
  const [settings, setSettings] = useState({ layout: 'bottom', maxItems: 200, showStatusBar: true, theme: 'dark' })
  const [searchText, setSearchText] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [toast, setToast] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const searchRef = useRef(null)
  const scrollRef = useRef(null)

  // ★ 优化：用 ref 缓存动态值，避免键盘监听器反复重建
  const historyRef = useRef(history)
  const pinnedRef = useRef(pinned)
  const settingsRef = useRef(settings)
  historyRef.current = history
  pinnedRef.current = pinned
  settingsRef.current = settings

  const layout = settings.layout || 'bottom'

  const showToast = useCallback((msg) => { setToast(msg) }, [])

  // 初始化
  useEffect(() => {
    if (window.clipboardAPI) {
      window.clipboardAPI.onWindowShown((data) => {
        setHistory(data.history || [])
        setPinned(data.pinned || [])
        if (data.settings) setSettings(data.settings)
        setSearchText('')
        setSelectedId(null)
        setTimeout(() => searchRef.current?.focus(), 50)
      })

      // ★ 防抖 + 去重：用 ref 跟踪上次数据，相同数据跳过 setState
      let lastHistoryLength = 0
      let lastHistoryFirstId = null
      let lastHistoryLastId = null

      window.clipboardAPI.onHistoryUpdated((newHistory) => {
        // 快速去重：长度和首尾 ID 没变就跳过（避免无谓重渲染）
        const newLen = newHistory ? newHistory.length : 0
        const newFirstId = newLen > 0 ? newHistory[0].id : null
        const newLastId = newLen > 0 ? newHistory[newLen - 1].id : null

        if (newLen === lastHistoryLength && newFirstId === lastHistoryFirstId && newLastId === lastHistoryLastId) {
          return  // 数据没变化，跳过
        }

        lastHistoryLength = newLen
        lastHistoryFirstId = newFirstId
        lastHistoryLastId = newLastId
        setHistory(newHistory)
      })

      window.clipboardAPI.getHistory().then((data) => {
        setHistory(data.history || [])
        setPinned(data.pinned || [])
      })

      window.clipboardAPI.getSettings().then((s) => {
        if (s) setSettings(s)
      })
    } else {
      setHistory(MOCK_DATA)
    }

    // 键盘快捷键
    const handleKeyDown = (e) => {
      // 设置面板打开时，ESC 关闭设置
      if (showSettings) {
        if (e.key === 'Escape') setShowSettings(false)
        return
      }
      if (e.key === 'Escape') {
        window.clipboardAPI?.hideWindow()
      }
      // ★ 用 ref 读取最新值，避免将 history/pinned 加入依赖数组
      const curHistory = historyRef.current
      const curPinned = pinnedRef.current
      if (e.key === 'Enter' && selectedId) {
        const item = [...curHistory, ...curPinned].find(h => h.id === selectedId)
        if (item) handlePaste(item)
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        // ★ 从 ref 读取，避免闭包陈旧值
        const list = getDisplayItemsFrom(curHistory, curPinned)
        const idx = list.findIndex(h => h.id === selectedId)
        if (idx < list.length - 1) setSelectedId(list[idx + 1].id)
        else if (list.length > 0) setSelectedId(list[0].id)
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        const list = getDisplayItemsFrom(curHistory, curPinned)
        const idx = list.findIndex(h => h.id === selectedId)
        if (idx > 0) setSelectedId(list[idx - 1].id)
        else if (list.length > 0) setSelectedId(list[list.length - 1].id)
      }
      // ★ 从 settings 读取自定义设置快捷键
      const curSettings = settingsRef.current
      if (matchAccelerator(e, curSettings.shortcuts?.openSettings || 'Ctrl+Comma')) {
        e.preventDefault()
        setShowSettings(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedId, showSettings])  // ★ 仅依赖 selectedId 和 showSettings，不再依赖 history/pinned！

  // 主题应用
  useEffect(() => {
    const theme = settings.theme || 'dark'
    applyTheme(theme)

    // 跟随系统模式：监听系统主题变化
    if (theme === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme('system')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings.theme])

  // 过滤 + 搜索
  function getDisplayItems() {
    let items = activeTab === 'pinned' ? [...pinned] : [...history]
    if (activeTab === 'text') items = items.filter(i => i.type === 'text' && !isUrl(i.content))
    if (activeTab === 'image') items = items.filter(i => i.type === 'image')
    if (activeTab === 'link') items = items.filter(i => i.type === 'text' && isUrl(i.content))

    if (searchText.trim()) {
      const q = searchText.toLowerCase()
      items = items.filter(i => i.type === 'text' && i.content.toLowerCase().includes(q))
    }
    return items
  }

  // ★ 供键盘事件处理器使用（从 ref 读取值，避免依赖 state）
  function getDisplayItemsFrom(hist, pin) {
    let items = activeTab === 'pinned' ? [...pin] : [...hist]
    if (activeTab === 'text') items = items.filter(i => i.type === 'text' && !isUrl(i.content))
    if (activeTab === 'image') items = items.filter(i => i.type === 'image')
    if (activeTab === 'link') items = items.filter(i => i.type === 'text' && isUrl(i.content))

    if (searchText.trim()) {
      const q = searchText.toLowerCase()
      items = items.filter(i => i.type === 'text' && i.content.toLowerCase().includes(q))
    }
    return items
  }

  async function handlePaste(item) {
    if (window.clipboardAPI) {
      await window.clipboardAPI.pasteItem(item)
    } else {
      navigator.clipboard.writeText(item.content)
    }
    showToast('已粘贴')
  }

  async function handlePin(itemId) {
    if (window.clipboardAPI) {
      const result = await window.clipboardAPI.pinItem(itemId)
      if (result) { setHistory(result.history); setPinned(result.pinned) }
    }
    const item = history.find(h => h.id === itemId)
    showToast(item?.pinned ? '已取消固定' : '已固定')
  }

  async function handleDelete(itemId) {
    if (window.clipboardAPI) {
      const result = await window.clipboardAPI.deleteItem(itemId)
      if (result) { setHistory(result.history); setPinned(result.pinned) }
    } else {
      setHistory(prev => prev.filter(h => h.id !== itemId))
    }
  }

  async function handleClear() {
    if (window.clipboardAPI) {
      const result = await window.clipboardAPI.clearHistory()
      setHistory([]); setPinned([])
    } else {
      setHistory([])
    }
    showToast('已清空历史')
  }

  async function handleSaveSettings(newSettings) {
    if (window.clipboardAPI) {
      await window.clipboardAPI.saveSettings(newSettings)
    }
    setSettings(newSettings)
    showToast('设置已保存')
  }

  const displayItems = getDisplayItems()
  const tabs = [
    { id: 'all', label: '全部', count: history.length },
    { id: 'pinned', label: '固定', count: pinned.length },
    { id: 'text', label: '文字', count: history.filter(h => h.type === 'text' && !isUrl(h.content)).length },
    { id: 'link', label: '链接', count: history.filter(h => i => h.type === 'text' && isUrl(h.content)).length },
    { id: 'image', label: '图片', count: history.filter(h => h.type === 'image').length },
  ]

  // ═══ 渲染 ═══
  return (
    <div className={`app-container ${layout}-layout animate-slide-up`}>
      {toast && <Toast message={toast} onHide={() => setToast(null)} />}
      {showSettings && <SettingsPanel settings={settings} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />}

      {/* 搜索栏 */}
      <div className="search-bar">
        <span className="search-icon">⌕</span>
        <input ref={searchRef} className="search-input" placeholder="搜索剪贴板历史..."
          value={searchText} onChange={e => setSearchText(e.target.value)}
          autoComplete="off" spellCheck={false} />
        {searchText && (
          <button className="search-clear" onClick={() => setSearchText('')}>✕</button>
        )}
        <button className="search-settings" onClick={() => setShowSettings(true)} title="设置 (Ctrl+,)">⚙</button>
        <button className="search-clear-btn" onClick={handleClear} title="清空历史">清空</button>
      </div>

      {/* 标签栏 */}
      <div className="tab-bar">
        {tabs.map(tab => (
          <div key={tab.id} className={`tab-item ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
            {tab.count > 0 && <span className="tab-count" style={{
              background: activeTab === tab.id ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
              color: activeTab === tab.id ? '#818cf8' : 'rgba(255,255,255,0.3)',
            }}>{tab.count}</span>}
          </div>
        ))}
      </div>

      {/* 内容区 — 根据布局切换 */}
      <div className="content-area">
        {displayItems.length === 0 ? (
          <EmptyState message={
            searchText ? `未找到包含 "${searchText}" 的记录`
            : activeTab === 'pinned' ? '暂无固定内容\n点击卡片上的 ☆ 可固定'
            : '暂无记录\n复制内容后将自动出现在这里'
          } layout={layout} />
        ) : layout === 'bottom' ? (
          /* ====== 底部模式：横向滚动卡片 ====== */
          <div className="cards-scroll" ref={scrollRef}>
            {displayItems.map((item, idx) => (
              <BottomCard key={item.id} item={item} isSelected={selectedId === item.id}
                delay={Math.min(idx * 20, 200)} onSelect={setSelectedId}
                onPaste={handlePaste} onPin={handlePin} onDelete={handleDelete} />
            ))}
          </div>
        ) : (
          /* ====== 右侧模式：垂直列表 ====== */
          <div className="cards-list" ref={scrollRef}>
            {displayItems.map((item, idx) => (
              <RightCard key={item.id} item={item} isSelected={selectedId === item.id}
                index={idx} onSelect={setSelectedId}
                onPaste={handlePaste} onPin={handlePin} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {/* 状态栏 */}
      {(settings.showStatusBar !== false) && (
        <div className="status-bar">
          <span className="status-text">
            {displayItems.length} 条记录{selectedId && ' · 已选中 1 条'}
            <span className="layout-indicator">{layout === 'bottom' ? '◧ 底部' : '▤ 右侧'}</span>
          </span>
          <div className="shortcut-hint">
            {layout === 'bottom' ? (
              <>
                <span><span className="kbd">双击</span> 粘贴</span>
                <span><span className="kbd">← →</span> 选择</span>
              </>
            ) : (
              <>
                <span><span className="kbd">双击</span> 粘贴</span>
                <span><span className="kbd">↑ ↓</span> 选择</span>
              </>
            )}
            <span><span className="kbd">Enter</span> 粘贴选中</span>
            <span><span className="kbd">Esc</span> 关闭</span>
          </div>
        </div>
      )}
    </div>
  )
}

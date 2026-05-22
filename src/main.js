const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── 状态 ──────────────────────────────────────────────────────

let history = [];
let settings = { layout: 'bottom', maxItems: 200, showStatusBar: true, theme: 'dark', autoStart: false, toggleShortcut: 'Ctrl+Shift+V', settingsShortcut: 'Ctrl+Shift+S', skipUpdateVersion: null, maxStorageMb: 200 };
let searchText = '';
let activeTab = 'all';
let selectedId = null;
let showSettings = false;
let toast = null;
let toastTimer = null;
let updateInfo = null;
let checkingUpdate = false;
let appVersion = '';
let recordingTarget = null; // 'toggle' | 'settings' | null
let recordingKeys = '';
let confirmDialog = null; // { message, onConfirm, onCancel }
let storageInfo = null; // { totalSizeMb, imageCount }

// ─── LRU 缓存（缩略图） ──────────────────────────────────────

const THUMB_CACHE_MAX = 30; // 最多缓存 30 张缩略图
const thumbCache = new Map(); // id -> data URL (有序 Map，用于 LRU)

function getCachedThumb(id) {
  if (thumbCache.has(id)) {
    // 访问时移到末尾（最近使用）
    const val = thumbCache.get(id);
    thumbCache.delete(id);
    thumbCache.set(id, val);
    return val;
  }
  return null;
}

function setCachedThumb(id, dataUrl) {
  if (thumbCache.has(id)) thumbCache.delete(id);
  thumbCache.set(id, dataUrl);
  // 超限时淘汰最旧的
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    thumbCache.delete(oldest);
  }
}

function clearThumbCache() {
  thumbCache.clear();
}

// ─── 搜索防抖 ──────────────────────────────────────────────────

let searchDebounceTimer = null;

// ─── IntersectionObserver（懒加载） ────────────────────────────

let imageObserver = null;

function setupImageObserver() {
  if (imageObserver) imageObserver.disconnect();

  imageObserver = new IntersectionObserver((entries) => {
    const toLoad = [];
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = parseInt(entry.target.dataset.imageId);
        if (id) toLoad.push({ el: entry.target, id });
        imageObserver.unobserve(entry.target);
      }
    }
    if (toLoad.length > 0) {
      loadThumbnails(toLoad);
    }
  }, {
    root: document.querySelector('.bottom-scroll') || document.querySelector('.right-scroll') || null,
    rootMargin: '200px', // 提前 200px 开始加载
    threshold: 0,
  });
}

// ─── 初始化 ────────────────────────────────────────────────────

async function init() {
  try {
    const [h, s] = await Promise.all([invoke('get_history'), invoke('get_settings')]);
    history = h || [];
    settings = s || settings;
    appVersion = s?.version || '';
    document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
  } catch (e) {
    console.error('初始化失败:', e);
  }

  // 监听后端事件
  listen('history-updated', async () => {
    history = await invoke('get_history');
    render();
  });

  listen('settings-updated', async () => {
    const s = await invoke('get_settings');
    if (s) {
      settings = s;
      appVersion = s.version || appVersion;
      document.documentElement.setAttribute('data-theme', settings.theme);
      render();
    }
  });

  listen('update-check-result', (e) => {
    updateInfo = e.payload;
    checkingUpdate = false;
    render();
  });

  // 窗口显示动画
  listen('window-shown', () => {
    const appEl = document.getElementById('app');
    if (!appEl) return;
    appEl.classList.remove('animate-show');
    void appEl.offsetWidth; // force reflow
    appEl.classList.add('animate-show');
    setTimeout(() => appEl.classList.remove('animate-show'), 200);
  });

  setupImageObserver();
  render();
}

// ─── 工具函数 ──────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function isUrl(text) {
  try { new URL(text); return true; } catch { return false; }
}

function getContentType(item) {
  if (item.content.type === 'image') return 'image';
  if (item.content.type === 'text' && isUrl(item.content.content)) return 'link';
  return 'text';
}

function getContentText(item) {
  return item.content.type === 'text' ? item.content.content : item.content.preview;
}

function getContentPreview(item) {
  const text = getContentText(item);
  return text.length > 80 ? text.slice(0, 80) + '...' : text;
}

function getDisplayItems() {
  let items = [...history];
  if (searchText) {
    const q = searchText.toLowerCase();
    items = items.filter(i => {
      const text = getContentText(i).toLowerCase();
      return text.includes(q);
    });
  }
  switch (activeTab) {
    case 'pinned': return items.filter(i => i.pinned);
    case 'text': return items.filter(i => i.content.type === 'text' && !isUrl(i.content.content));
    case 'link': return items.filter(i => i.content.type === 'text' && isUrl(i.content.content));
    case 'image': return items.filter(i => i.content.type === 'image');
    default: return items;
  }
}

function showToast(msg) {
  toast = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast = null; render(); }, 2000);
  render();
}

// ─── 操作 ──────────────────────────────────────────────────────

async function handlePaste(itemId) {
  try { await invoke('paste_item', { itemId }); } catch (e) { console.error(e); }
}

async function handleCopy(itemId) {
  try { await invoke('copy_item', { itemId }); showToast('已复制'); } catch (e) { console.error(e); }
}

async function handlePin(itemId) {
  try { history = await invoke('pin_item', { itemId }); render(); } catch (e) { console.error(e); }
}

async function handleDelete(itemId) {
  try {
    history = await invoke('delete_item', { itemId });
    clearThumbCache(); // 清除缓存，避免残留
    render();
  } catch (e) { console.error(e); }
}

async function handleClear() {
  confirmDialog = {
    message: '确定清空所有未固定的剪贴板历史吗？',
    onConfirm: async () => {
      confirmDialog = null;
      try {
        history = await invoke('clear_history');
        clearThumbCache();
        render();
        showToast('已清空');
      } catch (e) { console.error(e); }
    },
    onCancel: () => { confirmDialog = null; render(); }
  };
  render();
}

async function handleCheckUpdate() {
  if (checkingUpdate) return;
  checkingUpdate = true;
  updateInfo = null;
  render();
  try {
    const result = await invoke('check_for_update');
    updateInfo = result;
    checkingUpdate = false;
    render();
  } catch (e) {
    updateInfo = { available: false, error: true, message: '检查失败' };
    checkingUpdate = false;
    render();
  }
}

async function handleSkipUpdate(version) {
  try { await invoke('skip_update_version', { version }); updateInfo = null; render(); } catch (e) { console.error(e); }
}

async function handleSaveSettings() {
  try {
    await invoke('save_settings_cmd', { newSettings: settings });
    document.documentElement.setAttribute('data-theme', settings.theme);
    showToast('设置已保存');
    render();
  } catch (e) { console.error(e); }
}

async function handleHideWindow() {
  try { await invoke('hide_window'); } catch (e) { console.error(e); }
}

// ─── 快捷键录制 ──────────────────────────────────────────────────

/** 将键盘事件转为 Accelerator 格式 */
function eventToAccelerator(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Super');
  if (e.shiftKey) parts.push('Shift');

  const mainKey = ['Control', 'Alt', 'Meta', 'Shift'].includes(e.key) ? null : e.key;
  if (mainKey) {
    if (mainKey.length === 1) parts.push(mainKey.toUpperCase());
    else parts.push(mainKey);
  }
  return parts.join('+');
}

/** 将 Accelerator 格式转为显示字符串 */
function acceleratorToDisplay(acc) {
  if (!acc) return '未设置';
  return acc.replace(/Ctrl/g, '⌃ Ctrl').replace(/Alt/g, '⌥ Alt').replace(/Shift/g, '⇧ Shift').replace(/Super/g, '⊞ Win').replace(/\+/g, ' + ');
}

function startRecording(target) {
  recordingTarget = target;
  recordingKeys = '';
  render();
}

// ─── 渲染 ──────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  const isRight = settings.layout === 'right';
  const layoutClass = isRight ? 'right-layout' : 'bottom-layout';
  const items = getDisplayItems();

  const pinned = history.filter(i => i.pinned).length;
  const textCount = history.filter(i => i.content.type === 'text' && !isUrl(i.content.content)).length;
  const linkCount = history.filter(i => i.content.type === 'text' && isUrl(i.content.content)).length;
  const imageCount = history.filter(i => i.content.type === 'image').length;

  const tabs = [
    { id: 'all', label: '全部', count: history.length },
    { id: 'pinned', label: '固定', count: pinned },
    { id: 'text', label: '文字', count: textCount },
    { id: 'link', label: '链接', count: linkCount },
    { id: 'image', label: '图片', count: imageCount },
  ];

  if (showSettings) {
    const oldContent = document.querySelector('.settings-content');
    const scrollTop = oldContent ? oldContent.scrollTop : 0;

    app.innerHTML = renderSettings();
    bindSettingsEvents();

    const newContent = document.querySelector('.settings-content');
    if (newContent) newContent.scrollTop = scrollTop;
    // 加载存储信息
    loadStorageInfo();
    return;
  }

  app.innerHTML = `
    <div class="${layoutClass}" style="display:flex;flex-direction:column;height:100%;">
      ${updateInfo?.available ? renderUpdateBanner() : ''}

      <div class="top-bar">
        <div class="search-bar">
          <span class="search-icon">🔍</span>
          <input class="search-input" type="text" placeholder="搜索剪贴板..." value="${searchText}" />
          ${searchText ? '<button class="search-clear">✕</button>' : ''}
        </div>
        <div class="tab-bar">
          ${tabs.map(t => `
            <div class="tab-item ${activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
              ${t.label}<span class="tab-count">${t.count}</span>
            </div>
          `).join('')}
        </div>
        <div class="top-actions">
          <button class="top-action-btn" id="btn-clear" title="清空历史">🗑️</button>
          <button class="top-action-btn" id="btn-settings" title="设置">⚙️</button>
        </div>
      </div>

      <div class="content-area">
        ${items.length === 0 ? `
          <div class="empty-state">
            <span class="empty-icon">📋</span>
            <span>${searchText ? '没有匹配的结果' : '还没有剪贴板内容'}</span>
          </div>
        ` : isRight ? `
          <div class="right-scroll">
            ${items.map(i => renderRightCard(i)).join('')}
          </div>
        ` : `
          <div class="bottom-scroll">
            ${items.map(i => renderBottomCard(i)).join('')}
          </div>
        `}
      </div>

      ${settings.showStatusBar ? `
        <div class="status-bar">
          <span>${history.length} 条记录</span>
          <div class="shortcut-hint">
            ${isRight ? '<span><span class="kbd">↑ ↓</span> 选择</span>' : '<span><span class="kbd">← →</span> 选择</span>'}
            <span><span class="kbd">双击</span> 粘贴</span>
            <span><span class="kbd">Enter</span> 粘贴</span>
            <span><span class="kbd">Esc</span> 关闭</span>
          </div>
          <span class="version-badge">v${appVersion}</span>
        </div>
      ` : ''}
    </div>
    ${toast ? `<div class="toast">${toast}</div>` : ''}
    ${confirmDialog ? renderConfirmDialog() : ''}
  `;

  bindMainEvents();
  observeImages();
}

function renderBottomCard(item) {
  const type = getContentType(item);
  const isSelected = selectedId === item.id;
  const content = item.content;
  const isImage = content.type === 'image';
  const cachedSrc = isImage ? getCachedThumb(item.id) : '';

  return `
    <div class="clip-card bottom-card ${isSelected ? 'selected' : ''}" data-id="${item.id}">
      <div class="card-actions">
        <button class="card-action-btn ${item.pinned ? 'pin-active' : ''}" data-action="pin">📌</button>
        <button class="card-action-btn" data-action="delete">✕</button>
      </div>
      <div class="card-content ${isImage ? 'image-content' : ''}">
        ${isImage ? `
          <img class="card-image" ${cachedSrc ? `src="${cachedSrc}"` : `data-image-id="${item.id}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"`} alt="图片"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
               onload="this.style.opacity=1" style="opacity:0.3;transition:opacity 0.2s" />
          <div class="card-image-placeholder" style="display:none">🖼</div>
        ` : `
          <div class="card-text">${escapeHtml(getContentPreview(item))}</div>
        `}
      </div>
      <div class="card-footer">
        <span class="card-time">${formatTime(item.time)}</span>
        <span class="card-type-badge ${type}">${type === 'link' ? '链接' : type === 'image' ? '图片' : '文字'}</span>
      </div>
    </div>
  `;
}

function renderRightCard(item) {
  const type = getContentType(item);
  const isSelected = selectedId === item.id;
  const content = item.content;
  const isImage = content.type === 'image';
  const cachedSrc = isImage ? getCachedThumb(item.id) : '';

  return `
    <div class="clip-card right-card ${isSelected ? 'selected' : ''}" data-id="${item.id}">
      <div class="right-card-main">
        ${isImage ? `
          <img class="right-card-image" ${cachedSrc ? `src="${cachedSrc}"` : `data-image-id="${item.id}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"`} alt="图片"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
               onload="this.style.opacity=1" style="opacity:0.3;transition:opacity 0.2s" />
          <div class="right-card-image-placeholder" style="display:none;width:56px;height:56px;min-width:56px;align-items:center;justify-content:center;background:var(--card-bg);border-radius:6px;color:var(--text-tertiary);font-size:16px">🖼</div>
        ` : ''}
        <div class="right-card-text">${escapeHtml(getContentPreview(item))}</div>
      </div>
      <div class="right-card-meta">
        <span class="card-time">${formatTime(item.time)}</span>
        <div class="right-card-actions">
          <button class="card-action-btn ${item.pinned ? 'pin-active' : ''}" data-action="pin">📌</button>
          <button class="card-action-btn" data-action="delete">✕</button>
        </div>
      </div>
    </div>
  `;
}

function renderUpdateBanner() {
  return `
    <div class="update-banner">
      <div class="update-banner-info">
        <span>🎉</span>
        <span>发现新版本 <strong>v${updateInfo.latest_version}</strong></span>
      </div>
      <div class="update-banner-actions">
        <a class="update-btn-download" href="${updateInfo.download_url}" target="_blank" id="btn-download-update">下载</a>
        <button class="update-btn-skip" id="btn-skip-update">不再提示</button>
        <button class="update-btn-dismiss" id="btn-dismiss-update">✕</button>
      </div>
    </div>
  `;
}

function renderSettings() {
  return `
    <div class="settings-overlay" id="settings-overlay">
      <div class="settings-panel">
        <div class="settings-header">
          <span class="settings-title">设置</span>
          <button class="settings-close" id="settings-close">✕</button>
        </div>
        <div class="settings-content">
        <div class="settings-group">
          <div class="settings-group-title">外观</div>
          <div class="settings-row">
            <span class="settings-label">布局</span>
            <select class="settings-select" id="setting-layout">
              <option value="bottom" ${settings.layout === 'bottom' ? 'selected' : ''}>底部</option>
              <option value="right" ${settings.layout === 'right' ? 'selected' : ''}>右侧</option>
            </select>
          </div>
          <div class="settings-row">
            <span class="settings-label">主题</span>
            <select class="settings-select" id="setting-theme">
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>浅色</option>
            </select>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">通用</div>
          <div class="settings-row">
            <span class="settings-label">开机自启动</span>
            <div class="toggle ${settings.autoStart ? 'active' : ''}" id="setting-autostart"></div>
          </div>
          <div class="settings-row">
            <span class="settings-label">显示状态栏</span>
            <div class="toggle ${settings.showStatusBar ? 'active' : ''}" id="setting-statusbar"></div>
          </div>
          <div class="settings-row">
            <span class="settings-label">最大条数</span>
            <select class="settings-select" id="setting-maxitems">
              <option value="100" ${settings.maxItems === 100 ? 'selected' : ''}>100</option>
              <option value="200" ${settings.maxItems === 200 ? 'selected' : ''}>200</option>
              <option value="500" ${settings.maxItems === 500 ? 'selected' : ''}>500</option>
            </select>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">存储</div>
          <div class="settings-row">
            <span class="settings-label">图片存储上限</span>
            <select class="settings-select" id="setting-maxstorage">
              <option value="100" ${settings.maxStorageMb === 100 ? 'selected' : ''}>100 MB</option>
              <option value="200" ${settings.maxStorageMb === 200 ? 'selected' : ''}>200 MB</option>
              <option value="500" ${settings.maxStorageMb === 500 ? 'selected' : ''}>500 MB</option>
              <option value="1024" ${settings.maxStorageMb === 1024 ? 'selected' : ''}>1 GB</option>
              <option value="0" ${settings.maxStorageMb === 0 ? 'selected' : ''}>无限制</option>
            </select>
          </div>
          <div class="settings-row storage-info-row" id="storage-info-row">
            <span class="settings-label">当前存储用量</span>
            <span class="storage-info-value" id="storage-info-value">加载中...</span>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">快捷键</div>
          <div class="shortcut-row">
            <div class="shortcut-info">
              <span class="settings-label">显示 / 隐藏窗口</span>
              <span class="shortcut-desc">全局快捷键</span>
            </div>
            <button class="shortcut-recorder ${recordingTarget === 'toggle' ? 'recording' : ''}" id="recorder-toggle">
              ${recordingTarget === 'toggle' ? (recordingKeys || '按下快捷键...') : acceleratorToDisplay(settings.toggleShortcut)}
            </button>
          </div>
          <div class="shortcut-row">
            <div class="shortcut-info">
              <span class="settings-label">打开设置</span>
              <span class="shortcut-desc">应用内快捷键</span>
            </div>
            <button class="shortcut-recorder ${recordingTarget === 'settings' ? 'recording' : ''}" id="recorder-settings">
              ${recordingTarget === 'settings' ? (recordingKeys || '按下快捷键...') : acceleratorToDisplay(settings.settingsShortcut)}
            </button>
          </div>
        </div>

        <div class="about-section">
          <div class="settings-group-title">关于</div>
          <div class="about-info">
            <span class="about-name">ClipMate</span>
            ${appVersion ? `<span class="about-version">v${appVersion}</span>` : ''}
          </div>
          <button class="btn-check-update ${checkingUpdate ? 'checking' : ''}" id="btn-check-update" ${checkingUpdate ? 'disabled' : ''}>
            ${checkingUpdate ? '检查中...' : '检查更新'}
          </button>
          ${updateInfo && !updateInfo.available && !updateInfo.error ? '<span class="update-result-text">已是最新版本 ✅</span>' : ''}
          ${updateInfo?.error ? `<span class="update-result-text error">${updateInfo.error || '检查失败'}</span>` : ''}
          ${updateInfo?.available ? `
            <div class="update-available-inline">
              <span>发现新版本 v${updateInfo.latest_version}</span>
              <a href="${updateInfo.download_url}" target="_blank">前往下载</a>
            </div>
          ` : ''}
        </div>
      </div>

        <div class="settings-footer">
          ${appVersion ? `<span class="version-badge">v${appVersion}</span>` : ''}
          <div style="flex:1"></div>
          <button class="btn-cancel" id="settings-cancel">取消</button>
          <button class="btn-save" id="settings-save">保存并应用</button>
        </div>
      </div>
    </div>
  `;
}

function renderConfirmDialog() {
  return `
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog">
        <div class="confirm-message">${confirmDialog.message}</div>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-cancel" id="confirm-cancel">取消</button>
          <button class="confirm-btn confirm-ok" id="confirm-ok">确定</button>
        </div>
      </div>
    </div>
  `;
}

// ─── 图片懒加载 ──────────────────────────────────────────────

/** 观察所有未加载的图片元素 */
function observeImages() {
  if (!imageObserver) setupImageObserver();
  const elements = document.querySelectorAll('[data-image-id]');
  elements.forEach(el => imageObserver.observe(el));
}

/** 并发加载缩略图（分批，每批 5 张） */
async function loadThumbnails(items) {
  const BATCH_SIZE = 5;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ({ el, id }) => {
        const dataUrl = await invoke('get_thumbnail_data_url', { itemId: id });
        return { el, id, dataUrl };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { el, id, dataUrl } = result.value;
        setCachedThumb(id, dataUrl);
        if (document.contains(el)) {
          el.src = dataUrl;
          el.style.opacity = '1';
          el.removeAttribute('data-image-id');
        }
      } else {
        const { el } = batch[results.indexOf(result)];
        if (document.contains(el)) {
          el.style.display = 'none';
          const placeholder = el.nextElementSibling;
          if (placeholder) placeholder.style.display = 'flex';
        }
      }
    }
  }
}

/** 加载存储信息 */
async function loadStorageInfo() {
  try {
    storageInfo = await invoke('get_storage_info');
    const el = document.getElementById('storage-info-value');
    if (el && storageInfo) {
      const sizeStr = storageInfo.total_size_mb >= 1024
        ? `${(storageInfo.total_size_mb / 1024).toFixed(1)} GB`
        : `${storageInfo.total_size_mb} MB`;
      el.textContent = `${sizeStr}（${storageInfo.image_count} 张图片）`;

      // 根据用量设置颜色
      const ratio = settings.maxStorageMb > 0
        ? storageInfo.total_size_mb / settings.maxStorageMb
        : 0;
      if (ratio > 0.9) el.style.color = '#ef4444';
      else if (ratio > 0.7) el.style.color = '#f59e0b';
      else el.style.color = 'var(--accent)';
    }
  } catch (e) {
    const el = document.getElementById('storage-info-value');
    if (el) el.textContent = '获取失败';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── 事件绑定 ──────────────────────────────────────────────────

function bindMainEvents() {
  // 搜索（防抖 200ms）
  const input = document.querySelector('.search-input');
  if (input) {
    input.addEventListener('input', (e) => {
      searchText = e.target.value;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => render(), 200);
    });
    input.focus();
  }

  const clearBtn = document.querySelector('.search-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => { searchText = ''; render(); });
  }

  // Tab
  document.querySelectorAll('.tab-item').forEach(el => {
    el.addEventListener('click', () => { activeTab = el.dataset.tab; render(); });
  });

  // 按钮
  const btnClear = document.getElementById('btn-clear');
  if (btnClear) btnClear.addEventListener('click', handleClear);

  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', () => { showSettings = true; render(); });

  // 卡片交互
  document.querySelectorAll('.clip-card').forEach(el => {
    const id = parseInt(el.dataset.id);

    // 单击选中（直接操作DOM，避免全量刷新）
    el.addEventListener('click', (e) => {
      if (e.target.closest('.card-action-btn') || e.target.closest('.right-card-actions button')) return;
      document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      selectedId = id;
    });

    // 双击粘贴
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.card-action-btn') || e.target.closest('.right-card-actions button')) return;
      handlePaste(id);
    });

    el.querySelectorAll('.card-action-btn, .right-card-actions button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'pin') handlePin(id);
        if (action === 'delete') handleDelete(id);
      });
    });
  });

  // 底部布局：鼠标滚轮转水平滚动
  const bottomScroll = document.querySelector('.bottom-scroll');
  if (bottomScroll) {
    bottomScroll.addEventListener('wheel', (e) => {
      e.preventDefault();
      bottomScroll.scrollBy({ left: e.deltaY, behavior: 'auto' });
    }, { passive: false });
  }

  // 更新横幅
  const btnDownload = document.getElementById('btn-download-update');
  if (btnDownload) btnDownload.addEventListener('click', () => { updateInfo = null; });

  const btnSkip = document.getElementById('btn-skip-update');
  if (btnSkip) btnSkip.addEventListener('click', () => { if (updateInfo?.latest_version) handleSkipUpdate(updateInfo.latest_version); });

  const btnDismiss = document.getElementById('btn-dismiss-update');
  if (btnDismiss) btnDismiss.addEventListener('click', () => { updateInfo = null; render(); });

  // 外部链接
  document.querySelectorAll('a[target="_blank"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.__TAURI__) {
        window.__TAURI__.opener.openUrl(a.href);
      }
    });
  });

  // 确认弹窗
  const confirmOk = document.getElementById('confirm-ok');
  if (confirmOk && confirmDialog) {
    confirmOk.addEventListener('click', () => { confirmDialog.onConfirm(); });
  }
  const confirmCancel = document.getElementById('confirm-cancel');
  if (confirmCancel && confirmDialog) {
    confirmCancel.addEventListener('click', () => { confirmDialog.onCancel(); });
  }
  const confirmOverlay = document.getElementById('confirm-overlay');
  if (confirmOverlay && confirmDialog) {
    confirmOverlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) { confirmDialog.onCancel(); }
    });
  }
}

function bindSettingsEvents() {
  document.getElementById('settings-close')?.addEventListener('click', () => { showSettings = false; render(); });
  document.getElementById('settings-cancel')?.addEventListener('click', () => { showSettings = false; render(); });
  document.getElementById('settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { showSettings = false; render(); }
  });
  document.getElementById('settings-save')?.addEventListener('click', handleSaveSettings);

  document.getElementById('setting-layout')?.addEventListener('change', (e) => { settings.layout = e.target.value; });
  document.getElementById('setting-theme')?.addEventListener('change', (e) => { settings.theme = e.target.value; });
  document.getElementById('setting-maxitems')?.addEventListener('change', (e) => { settings.maxItems = parseInt(e.target.value); });
  document.getElementById('setting-maxstorage')?.addEventListener('change', (e) => { settings.maxStorageMb = parseInt(e.target.value); });

  document.getElementById('setting-autostart')?.addEventListener('click', (e) => {
    settings.autoStart = !settings.autoStart;
    e.currentTarget.classList.toggle('active');
    invoke('set_autostart', { enable: settings.autoStart }).catch(err => console.error('autostart error:', err));
  });

  document.getElementById('setting-statusbar')?.addEventListener('click', (e) => {
    settings.showStatusBar = !settings.showStatusBar;
    e.currentTarget.classList.toggle('active');
  });

  document.getElementById('btn-check-update')?.addEventListener('click', handleCheckUpdate);

  // 快捷键录制器
  document.getElementById('recorder-toggle')?.addEventListener('click', () => startRecording('toggle'));
  document.getElementById('recorder-settings')?.addEventListener('click', () => startRecording('settings'));

  // 录制模式下的键盘监听
  if (recordingTarget) {
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        recordingTarget = null;
        recordingKeys = '';
        render();
        return;
      }

      const acc = eventToAccelerator(e);
      if (!acc) return;

      recordingKeys = acceleratorToDisplay(acc);

      // 有主键时自动确认
      if (!['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) {
        if (recordingTarget === 'toggle') settings.toggleShortcut = acc;
        else if (recordingTarget === 'settings') settings.settingsShortcut = acc;
        recordingTarget = null;
        recordingKeys = '';
      }
      render();
    };

    document.addEventListener('keydown', handler, true);
    window._cleanupRecorder = () => document.removeEventListener('keydown', handler, true);
  } else if (window._cleanupRecorder) {
    window._cleanupRecorder();
    window._cleanupRecorder = null;
  }
}

// ─── 键盘导航 ──────────────────────────────────────────────────

function setupKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    // 设置面板打开时只处理 ESC
    if (showSettings) {
      if (e.key === 'Escape') { showSettings = false; render(); }
      return;
    }

    // ESC 隐藏窗口
    if (e.key === 'Escape') {
      handleHideWindow();
      return;
    }

    // 应用内快捷键：打开设置（Ctrl+, 或 Ctrl+Shift+S）
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      showSettings = true;
      render();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      showSettings = true;
      render();
      return;
    }

    const items = getDisplayItems();
    if (items.length === 0) return;

    const isRight = settings.layout === 'right';
    const prevKey = isRight ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = isRight ? 'ArrowDown' : 'ArrowRight';

    if (e.key === prevKey) {
      e.preventDefault();
      const idx = items.findIndex(i => i.id === selectedId);
      let newIdx;
      if (idx > 0) newIdx = idx - 1;
      else if (idx === -1 && items.length > 0) newIdx = 0;
      else newIdx = items.length - 1;
      selectedId = items[newIdx].id;
      document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('selected'));
      const newEl = document.querySelector(`.clip-card[data-id="${selectedId}"]`);
      if (newEl) newEl.classList.add('selected');
      scrollToSelected();
      return;
    }

    if (e.key === nextKey) {
      e.preventDefault();
      const idx = items.findIndex(i => i.id === selectedId);
      let newIdx;
      if (idx < items.length - 1) newIdx = idx + 1;
      else if (idx === -1 && items.length > 0) newIdx = 0;
      else newIdx = 0;
      selectedId = items[newIdx].id;
      document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('selected'));
      const newEl = document.querySelector(`.clip-card[data-id="${selectedId}"]`);
      if (newEl) newEl.classList.add('selected');
      scrollToSelected();
      return;
    }

    // Enter 粘贴选中项
    if (e.key === 'Enter' && selectedId) {
      e.preventDefault();
      handlePaste(selectedId);
      return;
    }
  });
}

function scrollToSelected() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.clip-card.selected');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });
}

// ─── 启动 ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupKeyboardNav();
});

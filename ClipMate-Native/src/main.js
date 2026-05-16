const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── 状态 ──────────────────────────────────────────────────────

let history = [];
let settings = { layout: 'bottom', maxItems: 200, showStatusBar: true, theme: 'dark', autoStart: false, toggleShortcut: 'Ctrl+Shift+V', settingsShortcut: 'Ctrl+Shift+S', skipUpdateVersion: null };
let searchText = '';
let activeTab = 'all';
let selectedId = null;
let showSettings = false;
let toast = null;
let toastTimer = null;
let updateInfo = null;
let checkingUpdate = false;
let appVersion = '';

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

  listen('update-check-result', (e) => {
    updateInfo = e.payload;
    checkingUpdate = false;
    render();
  });

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
  try { history = await invoke('delete_item', { itemId }); render(); } catch (e) { console.error(e); }
}

async function handleClear() {
  if (!confirm('确定清空所有未固定的剪贴板历史吗？')) return;
  try { history = await invoke('clear_history'); render(); showToast('已清空'); } catch (e) { console.error(e); }
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
    app.innerHTML = renderSettings();
    bindSettingsEvents();
    return;
  }

  app.innerHTML = `
    <div class="${layoutClass}" style="display:flex;flex-direction:column;height:100%;">
      ${updateInfo?.available ? renderUpdateBanner() : ''}

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
        <div style="margin-left:auto;display:flex;gap:4px;">
          <button style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:16px;padding:2px 6px;" id="btn-clear" title="清空历史">🗑️</button>
          <button style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:16px;padding:2px 6px;" id="btn-settings" title="设置">⚙️</button>
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
          <span class="version-badge">v${appVersion}</span>
        </div>
      ` : ''}
    </div>
    ${toast ? `<div class="toast">${toast}</div>` : ''}
  `;

  bindMainEvents();
}

function renderBottomCard(item) {
  const type = getContentType(item);
  const isSelected = selectedId === item.id;
  const content = item.content;

  return `
    <div class="clip-card bottom-card ${isSelected ? 'selected' : ''}" data-id="${item.id}">
      <div class="card-actions">
        <button class="card-action-btn ${item.pinned ? 'pin-active' : ''}" data-action="pin">📌</button>
        <button class="card-action-btn" data-action="delete">✕</button>
      </div>
      ${content.type === 'image' ? `
        <img class="card-image" src="${content.path}" alt="图片" loading="lazy" />
      ` : `
        <div class="card-content">
          <div class="card-text">${escapeHtml(getContentPreview(item))}</div>
        </div>
      `}
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

  return `
    <div class="clip-card right-card ${isSelected ? 'selected' : ''}" data-id="${item.id}">
      <div class="right-card-main">
        ${content.type === 'image' ? `<img class="right-card-image" src="${content.path}" alt="图片" loading="lazy" />` : ''}
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
    <div class="settings-overlay">
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
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── 事件绑定 ──────────────────────────────────────────────────

function bindMainEvents() {
  // 搜索
  const input = document.querySelector('.search-input');
  if (input) {
    input.addEventListener('input', (e) => { searchText = e.target.value; render(); });
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

    el.addEventListener('click', (e) => {
      if (e.target.closest('.card-action-btn') || e.target.closest('.right-card-actions button')) return;
      selectedId = id;
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
}

function bindSettingsEvents() {
  document.getElementById('settings-close')?.addEventListener('click', () => { showSettings = false; render(); });
  document.getElementById('settings-cancel')?.addEventListener('click', () => { showSettings = false; render(); });
  document.getElementById('settings-save')?.addEventListener('click', handleSaveSettings);

  document.getElementById('setting-layout')?.addEventListener('change', (e) => { settings.layout = e.target.value; });
  document.getElementById('setting-theme')?.addEventListener('change', (e) => { settings.theme = e.target.value; });
  document.getElementById('setting-maxitems')?.addEventListener('change', (e) => { settings.maxItems = parseInt(e.target.value); });

  document.getElementById('setting-autostart')?.addEventListener('click', (e) => {
    settings.autoStart = !settings.autoStart;
    e.currentTarget.classList.toggle('active');
  });

  document.getElementById('setting-statusbar')?.addEventListener('click', (e) => {
    settings.showStatusBar = !settings.showStatusBar;
    e.currentTarget.classList.toggle('active');
  });

  document.getElementById('btn-check-update')?.addEventListener('click', handleCheckUpdate);
}

// ─── 启动 ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

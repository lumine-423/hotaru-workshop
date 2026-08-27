/*! hotaru-workshop v2.3.5 —— 本地仓库壳 + 云端荧荧工坊入口
 * 结构：悬浮球 = 本地仓库（只在角色卡 Magic Fairy 上显示，对照星海工坊绑「魔法少女MVU测试」）
 *       扩展条目 = 星海式设置卡片（打开工坊 / 检查更新 / 更新）
 *       真正的工坊 = 云端网页 https://workshop.hotaruworkshop.l.cd/
 */
const GATEWAY = 'https://workshop.hotaruworkshop.l.cd';
const WORLDBOOK = '群星的资料库 v4.0';
const NS = 'hotaruWorkshop';
const EXT_VERSION = '2.3.5';
const SOURCE_KIND = 'hotaru-workshop';
const ENTRY_MARK = '[hotaru]';

let settings = {};
const knownWebWindows = new Set(); /* 云端网页窗口登记：登录/退出时向其广播（postMessage 双向同步） */

function getCtx() {
  try {
    if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') return window.SillyTavern.getContext();
  } catch { /* ignore */ }
  return null;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, err) {
  let t = document.querySelector('.hwf-toast');
  if (!t) { t = document.createElement('div'); t.className = 'hwf-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.toggle('hwf-toast-error', !!err); t.classList.add('hwf-toast-show');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('hwf-toast-show'), 3200);
}

/* ---------- 与云端网页的登录双向同步 ---------- */
function registerWebWindow(source) { if (source) knownWebWindows.add(source); }
function notifyWeb() {
  const payload = { type: 'hw-auth-changed', token: settings.token || '', user: settings.user || null, admin: !!settings.admin };
  for (const win of knownWebWindows) { try { win.postMessage(payload, webOriginOf()); } catch { /* 窗口已关闭等，忽略 */ } }
}
function webOriginOf() { try { return new URL(settings.gateway || GATEWAY).origin; } catch { return ''; } }

/* ---------- 设置 ---------- */
function loadSettings() {
  const c = getCtx();
  settings = (c && c.extensionSettings && c.extensionSettings[NS]) || {};
  settings = { gateway: GATEWAY, worldbook: WORLDBOOK, token: '', user: null, admin: false, pendingKey: '', ...settings };
}
function saveSettings() {
  const c = getCtx();
  if (!c || !c.extensionSettings) return;
  if (!c.extensionSettings[NS]) c.extensionSettings[NS] = {};
  c.extensionSettings[NS] = settings;
  if (c.saveSettingsDebounced) c.saveSettingsDebounced();
}

/* ---------- API（网关） ---------- */
async function api(path, opts = {}) {
  const url = settings.gateway.replace(/\/+$/, '') + path;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (settings.token) headers['Authorization'] = 'Bearer ' + settings.token;
  let res;
  try { res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'include', signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error('连不上工坊服务器（' + e.message + '）'); }
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.errors && data.errors[0]) || ('HTTP ' + res.status));
    err.status = res.status; /* 401 判定用：服务器错误体是 errors:["login required"]，不含 "HTTP 401" 字样 */
    throw err;
  }
  return data;
}
const apiDownloads = () => api('/api/workshop/me/downloads');
const apiDetail = (id) => api('/api/workshop/packages/' + encodeURIComponent(id));
const apiFavs = () => api('/api/workshop/me/favs');
const apiFavAdd = (id) => api('/api/workshop/me/favs', { method: 'POST', body: { packageId: id } });
const apiFavDel = (id) => api('/api/workshop/me/favs/' + encodeURIComponent(id), { method: 'DELETE' });
const apiDlAdd = (id) => api('/api/workshop/me/downloads', { method: 'POST', body: { packageId: id } });
const apiDlDel = (id) => api('/api/workshop/me/downloads/' + encodeURIComponent(id), { method: 'DELETE' });

/* ---------- 本地文件仓库（给没法跳转登录的玩家：网页导出 JSON → 这里导入） ---------- */
const LOCAL_PACKS_KEY = 'hwLocalPacks';
function loadLocalPacks() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_PACKS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function saveLocalPacks(list) { try { localStorage.setItem(LOCAL_PACKS_KEY, JSON.stringify(list || [])); } catch { /* ignore */ } }
function takePack(p, out) {
  if (!p || typeof p !== 'object') return;
  if (!p.title && !(p.payload)) return;
  out.push(p);
}
function parseImportFile(text) {
  const data = JSON.parse(text);
  const packs = [];
  if (data && data.kind === 'hotaru-workshop-package' && data.package) takePack(data.package, packs);
  else if (Array.isArray(data)) data.forEach((p) => takePack(p, packs));
  else if (data && Array.isArray(data.packages)) data.packages.forEach((p) => takePack(p, packs));
  else if (data && data.package) takePack(data.package, packs);
  else takePack(data, packs);
  if (!packs.length) throw new Error('文件里没有可导入的作品');
  return packs;
}
function upsertLocalPacks(incoming) {
  const cur = loadLocalPacks();
  for (const p of incoming) {
    const id = String(p.id || ('local.' + Date.now() + '.' + Math.random().toString(16).slice(2)));
    p.id = id;
    const i = cur.findIndex((x) => String(x.id) === id);
    if (i >= 0) cur[i] = p; else cur.push(p);
  }
  saveLocalPacks(cur);
  return cur;
}
function removeLocalPack(id) {
  saveLocalPacks(loadLocalPacks().filter((p) => String(p.id) !== String(id)));
}
function findLocalPack(id) { return loadLocalPacks().find((p) => String(p.id) === String(id)) || null; }

/* ---------- 登录（桥） ---------- */
const PENDING_KEY = 'hwPendingKey'; /* 同步 localStorage：ST 设置保存是 1 秒防抖，页面跳去 Discord 前根本来不及落盘 */
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function ub64url(s) { const b = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function beginLogin() {
  api('/api/workshop/health').then((h) => {
    const start = h && h.oauth && h.oauth.configured ? h.oauth.startUrl : '';
    if (!start) throw new Error('工坊登录尚未配置');
    const key = new Uint8Array(32); crypto.getRandomValues(key);
    const b64 = b64url(key);
    settings.pendingKey = b64; saveSettings();
    try { localStorage.setItem(PENDING_KEY, b64); } catch { /* ignore */ }
    const p = new URLSearchParams({ origin: location.origin, return: location.pathname + location.search, k: b64 });
    location.href = start + '?' + p.toString();
  }).catch((e) => toast(e.message, true));
}
async function finishLoginFromHash() {
  const hash = location.hash;
  if (!hash || !hash.includes('mf-auth=')) return false;
  const cipher = hash.split('mf-auth=')[1] || '';
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const stored = localStorage.getItem(PENDING_KEY) || '';
    localStorage.removeItem(PENDING_KEY);
    const key = ub64url(stored || settings.pendingKey || '');
    if (key.length !== 32) throw new Error('登录密钥丢失，请重试');
    const rawKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const buf = ub64url(cipher);
    if (buf.length < 29) throw new Error('登录回执损坏');
    const iv = buf.subarray(0, 12), data = buf.subarray(12, buf.length - 16), tag = buf.subarray(buf.length - 16);
    const combined = new Uint8Array(data.length + tag.length); combined.set(data, 0); combined.set(tag, data.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, rawKey, combined);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (!payload.ticket) throw new Error('登录回执缺少票据');
    const claimed = await api('/api/workshop/discord/claim', { method: 'POST', body: { ticket: payload.ticket } });
    settings.token = claimed.token; settings.user = claimed.user; settings.admin = !!claimed.admin; settings.pendingKey = '';
    saveSettings();
    notifyWeb();
    syncSessionCookie(); // 在工坊域名下种会话 cookie（顶层弹窗，浏览器不会拦）
    toast('登录成功，欢迎 ' + (claimed.user.displayName || claimed.user.username));
    renderRepo();
    return true;
  } catch (e) {
    settings.pendingKey = ''; saveSettings(); toast('登录失败：' + e.message, true); renderRepo(); return true;
  }
}

/* 用一次性票据在工坊域名下种会话 cookie：网页侧轮询 /me 就能拿到登录状态（无需窗口关系） */
async function syncSessionCookie() {
  try {
    const d = await api('/api/workshop/discord/cookie-ticket', { method: 'POST' });
    if (!d || !d.ticket) return;
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = settings.gateway + '/api/workshop/discord/cookie-sync?t=' + encodeURIComponent(d.ticket);
    document.body.appendChild(f);
    setTimeout(() => { try { f.remove(); } catch { /* ignore */ } }, 8000);
  } catch { /* 种 cookie 失败不影响本地登录；双端同步退化为网页打开时向插件要 token */ }
}
function handleAuthError() {
  const hash = location.hash;
  if (!hash || !hash.includes('mf-auth-error=')) return false;
  const msg = decodeURIComponent(hash.split('mf-auth-error=')[1] || '登录失败');
  history.replaceState(null, '', location.pathname + location.search);
  toast('登录失败：' + msg, true);
  return true;
}
function logout() {
  const t = settings.token || '';
  settings.token = ''; settings.user = null; settings.admin = false; saveSettings(); notifyWeb(); toast('已退出登录'); renderRepo();
  // 服务器侧撤销会话 + 清 cookie：带上清空前的 bearer（否则服务器只能撤 cookie，漏掉 bearer 会话）
  api('/api/workshop/discord/logout', { method: 'POST', headers: t ? { Authorization: 'Bearer ' + t } : {} }).catch(() => { /* 本地已退出，服务器撤销失败不阻塞 */ });
}

/* ---------- 世界书导入（沿用 v1 引擎） ---------- */
function entryMetaOf(entry) { if (!entry || !entry.comment) return null; try { const p = JSON.parse(entry.comment); if (p && p.source === SOURCE_KIND) return p; } catch { } return null; }
async function loadWorldbook() {
  const c = getCtx();
  if (c && typeof c.getWorldInfoNames === 'function') {
    const names = c.getWorldInfoNames();
    if (names && Array.isArray(names) && !names.some((n) => String(n) === settings.worldbook)) throw new Error('找不到世界书「' + settings.worldbook + '」');
  }
  if (c && typeof c.loadWorldInfo === 'function') { const d = await c.loadWorldInfo(settings.worldbook); if (d) return d; throw new Error('世界书读取失败'); }
  const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: c && c.getRequestHeaders ? c.getRequestHeaders() : {}, body: JSON.stringify({ name: settings.worldbook }) });
  if (!res.ok) throw new Error('世界书读取失败 HTTP ' + res.status);
  return res.json();
}
async function saveWorldbook(data) {
  const c = getCtx();
  if (c && typeof c.saveWorldInfo === 'function') { await c.saveWorldInfo(settings.worldbook, data, true); return; }
  const res = await fetch('/api/worldinfo/edit', { method: 'POST', headers: c && c.getRequestHeaders ? c.getRequestHeaders() : {}, body: JSON.stringify({ name: settings.worldbook, data }) });
  if (!res.ok) throw new Error('世界书保存失败 HTTP ' + res.status);
}
function entryTemplate() {
  return { uid: 0, displayIndex: 0, comment: '', disable: false, constant: true, selective: false, key: [], selectiveLogic: 0, keysecondary: [], scanDepth: null, vectorized: false, position: 1, role: null, depth: 4, order: 100, content: '', useProbability: true, probability: 100, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, sticky: null, cooldown: null, delay: null, addMemo: false, matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false, group: '', groupOverride: false, groupWeight: 100, caseSensitive: null, matchWholeWords: null, useGroupScoring: false, outletName: '', triggers: [], ignoreBudget: false, automationId: '' };
}
function findManaged(data) { const out = []; for (const [uidStr, entry] of Object.entries(data.entries || {})) { const m = entryMetaOf(entry); if (m) out.push({ uidStr, entry, meta: m }); } return out; }
function upsertEntry(data, name, patch) {
  for (const [uidStr, entry] of Object.entries(data.entries || {})) { const m = entryMetaOf(entry); if (m && m.name === name) { Object.assign(entry, patch); return entry; } }
  const entry = entryTemplate(); let maxUid = -1, maxDisp = -1;
  for (const [uidStr, e] of Object.entries(data.entries || {})) { const n = parseInt(uidStr, 10); if (Number.isInteger(n) && n > maxUid) maxUid = n; if (Number.isInteger(e.displayIndex) && e.displayIndex > maxDisp) maxDisp = e.displayIndex; }
  entry.uid = maxUid + 1; entry.displayIndex = maxDisp + 1; data.entries[String(entry.uid)] = entry; Object.assign(entry, patch); return entry;
}
function charControllerCode(names) {
  const list = names.map((n) => "'" + n.replace(/'/g, "\\'") + "'").join(', ');
  return '@@preprocessing\n<%\nfunction getVal(path) {\n    try {\n        return getvar(path, { defaults: undefined });\n    } catch(e) {\n        return undefined;\n    }\n}\nfunction exists(path) {\n    return getVal(path) !== undefined;\n}\n\nvar 在场角色 = getVal(\'stat_data.主角组.当前在场角色\') || [];\nif (!Array.isArray(在场角色)) {\n    在场角色 = [];\n}\nfunction isPresent(charName) {\n    return 在场角色.indexOf(charName) !== -1;\n}\n\nfunction isDLCUnlocked(charName) {\n    return exists(\'stat_data.DLC.\' + charName);\n}\n\nvar dlcCharacters = [' + list + '];\n\nvar activated = [];\n\ndlcCharacters.forEach(function(name) {\n    if (isPresent(name) && isDLCUnlocked(name)) {\n        activated.push(\'DLC/\' + name);\n    }\n});\n\nif (activated.length > 0) {\n    for (var i = 0; i < activated.length; i++) {\n%>\n<rule_动态内容_<%= activated[i] %>>\n<%- await getwi(activated[i]) %>\n</rule_动态内容_<%= activated[i] %>>\n<%\n    }\n}\n%>';
}
function eventControllerCode(configs) {
  const lines = configs.map((c) => "    { id: '" + c.id.replace(/'/g, "\\'") + "', dlcChar: '" + String(c.dlcChar || '').replace(/'/g, "\\'") + "' }");
  return '@@preprocessing\n<%\nfunction getVal(path) {\n    try {\n        return getvar(path, { defaults: undefined });\n    } catch(e) {\n        return undefined;\n    }\n}\nfunction exists(path) {\n    return getVal(path) !== undefined;\n}\nfunction isCompleted(eventId) {\n    return getVal(\'stat_data.剧情事件.已完成事件.\' + eventId) === true;\n}\n\nvar activated = [];\n\n// ===== 在此填入你的DLC事件配置 =====\n// 每一项：{ id: \'剧情事件/xxx\', dlcChar: \'角色名\' }\nvar eventConfigs = [\n' + lines.join(',\n') + '\n];\neventConfigs.forEach(function(config) {\n    var eventId = config.id;\n    var dlcChar = config.dlcChar;\n    if (!isCompleted(eventId) && exists(\'stat_data.DLC角色.\' + dlcChar)) {\n        activated.push(eventId);\n    }\n});\n\nif (activated.length > 0) {\n    for (var i = 0; i < activated.length; i++) {\n%>\n<rule_动态内容_<%= activated[i] %>>\n<%- await getwi(activated[i]) %>\n</rule_动态内容_<%= activated[i] %>>\n<%\n    }\n}\n%>';
}
function metaOf(pkg, extra) { return { source: SOURCE_KIND, kind: 'workshop_package', series: pkg.series || 'mf', category: pkg.category || pkg.type, packageId: pkg.id, revision: pkg.revision, packageContentHash: pkg.contentHash, ...extra }; }
async function importPackage(pkg) {
  const cat = pkg.category || pkg.type;
  const extra = pkg.payload && pkg.payload.extra ? pkg.payload.extra : {};
  if (!['character', 'faction', 'event', 'gameplay', 'rule', 'other'].includes(cat)) { toast('该类型暂不支持导入（' + cat + '）', true); return; }
  if (!window.confirm('导入「' + pkg.title + '」到世界书「' + settings.worldbook + '」？')) return;
  load(true);
  try {
    const data = await loadWorldbook();
    const base = metaOf(pkg, { name: '' });
    if (cat === 'character') {
      const roleNames = Array.isArray(extra.roleNames) && extra.roleNames.length ? extra.roleNames : [pkg.title];
      const overviewText = String(extra.summary || '').trim();
      for (const rn of roleNames) {
        const name = 'DLC/' + rn;
        const entry = upsertEntry(data, name, {});
        const m = JSON.parse(entry.comment || '{}'); Object.assign(m, base, { name, roleNames: [rn], category: 'character' }); entry.comment = JSON.stringify(m);
        entry.disable = true; entry.constant = false; entry.selective = false; entry.key = [ENTRY_MARK + rn];
        if (overviewText) entry.content = overviewText;
      }
      const parts = [];
      for (const x of findManaged(data).filter((it) => it.meta.category === 'character')) {
        const text = String(x.meta.summary || '').trim();
        if (x.meta.name && x.meta.name.startsWith('DLC/') && text) parts.push(x.meta.name.slice(4) + ':\n' + text);
      }
      if (parts.length) {
        const ov = upsertEntry(data, 'DLC/角色速览', {});
        const m = JSON.parse(ov.comment || '{}'); Object.assign(m, base, { name: 'DLC/角色速览', category: 'character' }); ov.comment = JSON.stringify(m);
        ov.content = parts.join('\n\n'); ov.constant = true; ov.selective = false; ov.disable = false; ov.order = 1001; ov.probability = 100; ov.depth = 4; ov.key = [ENTRY_MARK + 'overview'];
      }
      const allRoles = [];
      for (const x of findManaged(data).filter((it) => it.meta.category === 'character')) { if (x.meta.name && x.meta.name.startsWith('DLC/') && x.meta.roleNames) allRoles.push(...x.meta.roleNames); }
      const uniq = [...new Set(allRoles)];
      if (uniq.length) {
        const ctrl = upsertEntry(data, 'DLC角色控制器', {});
        const m = JSON.parse(ctrl.comment || '{}'); Object.assign(m, base, { name: 'DLC角色控制器', category: 'character' }); ctrl.comment = JSON.stringify(m);
        ctrl.content = charControllerCode(uniq); ctrl.constant = true; ctrl.selective = false; ctrl.disable = false; ctrl.order = 6; ctrl.probability = 100; ctrl.depth = 4; ctrl.key = [ENTRY_MARK + 'controller'];
      }
    }
    if (cat === 'faction') {
      const name = 'DLC/' + pkg.title;
      const entry = upsertEntry(data, name, {});
      const m = JSON.parse(entry.comment || '{}'); Object.assign(m, base, { name, category: 'faction', keywords: extra.keywords || [] }); entry.comment = JSON.stringify(m);
      entry.content = String(extra.content || '').trim(); entry.constant = false; entry.selective = true; entry.disable = false;
      entry.key = (Array.isArray(extra.keywords) && extra.keywords.length ? extra.keywords : [pkg.title]).slice(0, 20);
      entry.depth = 0; entry.position = 1;
      entry.order = 121 + findManaged(data).filter((x) => x.meta.category === 'faction').length;
      entry.probability = 100;
    }
    if (cat === 'gameplay' || cat === 'rule' || cat === 'other') {
      /* 玩法/规则/其他：无关键词板块，导入为蓝灯常驻条目（constant=true，忽略关键词触发） */
      const name = 'DLC/' + pkg.title;
      const entry = upsertEntry(data, name, {});
      const m = JSON.parse(entry.comment || '{}'); Object.assign(m, base, { name, category: cat }); entry.comment = JSON.stringify(m);
      entry.content = String(extra.content || '').trim();
      entry.constant = true; entry.selective = false; entry.disable = false;
      entry.key = [ENTRY_MARK + String(pkg.title || '')];
      entry.depth = 4; entry.position = 1;
      entry.order = cat === 'gameplay' ? 131 : cat === 'rule' ? 141 : 151;
      entry.probability = 100;
    }
    if (cat === 'event') {
      const eventNames = Array.isArray(extra.eventNames) && extra.eventNames.length ? extra.eventNames : [pkg.title];
      const roleNames = Array.isArray(extra.roleNames) ? extra.roleNames : [];
      const contentText = String(extra.content || '').trim();
      for (const en of eventNames) {
        const name = '剧情事件/' + en;
        const entry = upsertEntry(data, name, {});
        const m = JSON.parse(entry.comment || '{}'); Object.assign(m, base, { name, category: 'event', eventName: en, roleNames }); entry.comment = JSON.stringify(m);
        entry.content = contentText; entry.disable = true; entry.constant = false; entry.selective = false; entry.key = [ENTRY_MARK + 'event:' + en];
      }
      const configs = [];
      for (const x of findManaged(data).filter((it) => it.meta.category === 'event')) {
        if (x.meta.name && x.meta.name.startsWith('剧情事件/')) {
          const chars = Array.isArray(x.meta.roleNames) ? x.meta.roleNames : [];
          if (chars.length) configs.push({ id: x.meta.name, dlcChar: chars[0] });
        }
      }
      if (configs.length) {
        const ctrl = upsertEntry(data, 'DLC剧情事件控制器', {});
        const m = JSON.parse(ctrl.comment || '{}'); Object.assign(m, base, { name: 'DLC剧情事件控制器', category: 'event' }); ctrl.comment = JSON.stringify(m);
        ctrl.content = eventControllerCode(configs); ctrl.constant = true; ctrl.selective = false; ctrl.disable = false; ctrl.order = 7; ctrl.probability = 100; ctrl.depth = 4; ctrl.key = [ENTRY_MARK + 'eventctl'];
      }
    }
    await saveWorldbook(data);
    toast('已导入「' + pkg.title + '」');
    renderRepo();
  } catch (e) {
    toast('导入失败：' + e.message, true);
  } finally {
    load(false);
  }
}

/* ---------- 本地仓库悬浮窗 ---------- */
let ui = null;
let started = false;
function load(on) { if (ui) ui.loading.style.display = on ? 'flex' : 'none'; }
function openRepoPanel() {
  if (!ui) buildRepo();
  if (!ui) return;
  ui.veil.classList.add('on');
  ui.panel.classList.add('open');
  renderRepo();
  syncBallVisibility();
}
function closeRepoPanel() {
  if (!ui) return;
  ui.veil.classList.remove('on');
  ui.panel.classList.remove('open');
  syncBallVisibility();
}

/* 悬浮球：照搬星海工坊——认当前角色卡（卡名 / 世界书 / 卡内标记），不缓存上下文。 */
function currentCharacter() {
  const c = getCtx();
  if (!c) return null;
  const cid = c.characterId;
  if (cid == null || cid === '' || cid === false || cid === 'undefined') return null;
  const list = c.characters || [];
  const n = Number(cid);
  if (isFinite(n) && n >= 0 && list[n]) return list[n];
  try {
    return list.find((ch) => ch && (ch.avatar === cid || String(ch.avatar || '') === String(cid))) || null;
  } catch { return null; }
}
function charHaystack(ch) {
  if (!ch) return '';
  const bits = [];
  function push(v) {
    if (v == null) return;
    if (typeof v === 'string') { bits.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { bits.push(String(v)); return; }
    try { bits.push(JSON.stringify(v)); } catch { /* ignore */ }
  }
  push(ch.name); push(ch.avatar); push(ch.creatorcomment);
  const d = ch.data;
  if (d) {
    push(d.name); push(d.creator_notes); push(d.creatorcomment); push(d.extensions);
    if (d.character_book) push(d.character_book.name);
  }
  try {
    boundWorldNames(ch).forEach(push);
  } catch { /* ignore */ }
  return bits.join('\n');
}
function boundWorldNames(ch) {
  const names = [];
  const d = ch && ch.data;
  if (d && d.extensions && d.extensions.world) names.push(String(d.extensions.world));
  if (d && d.character_book && d.character_book.name) names.push(String(d.character_book.name));
  try {
    const c = getCtx();
    const wi = c && (c.worldInfo || c.world_info);
    const fileName = ch.avatar || '';
    const extra = wi && Array.isArray(wi.charLore) ? wi.charLore.find((e) => e && e.name === fileName) : null;
    if (extra && Array.isArray(extra.extraBooks)) names.push(...extra.extraBooks.filter(Boolean));
  } catch { /* ignore */ }
  return names;
}
function isHostCardName(n) {
  const s = String(n || '').trim();
  return s === 'Magic Fairy' || s.indexOf('Magic Fairy') === 0;
}
function isCurrentWorkshopCard() {
  try { if (document.getElementById('hwf-workshop')) return true; } catch { /* ignore */ }
  const ch = currentCharacter();
  if (!ch) return false;
  let hay = '';
  try { hay = charHaystack(ch); } catch { /* ignore */ }
  if (/hwf-workshop|hotaru-workshop|群星的资料库/.test(hay)) return true;
  try {
    const n = String(ch.name || (ch.data && ch.data.name) || '');
    const av = String(ch.avatar || '');
    if (isHostCardName(n) || isHostCardName(av.replace(/\.[^.]+$/, ''))) return true;
  } catch { /* ignore */ }
  return false;
}
function syncBallVisibility() {
  if (!ui) return;
  const on = isCurrentWorkshopCard();
  const panelOpen = ui.panel.classList.contains('open');
  const hide = !on || panelOpen;
  ui.ball.setAttribute('data-hidden', hide ? '1' : '0');
  ui.ball.setAttribute('aria-hidden', hide ? 'true' : 'false');
}
function onCharacterContextChanged() {
  if (ui && ui.panel.classList.contains('open') && !isCurrentWorkshopCard()) closeRepoPanel();
  else syncBallVisibility();
}
function bindBallVisibilityEvents() {
  const c = getCtx();
  const types = (c && (c.eventTypes || c.event_types)) || {};
  if (c && c.eventSource) {
    ['CHAT_CHANGED', 'CHAT_CREATED', 'CHAT_DELETED', 'CHARACTER_PAGE_LOADED', 'CHARACTER_DELETED', 'GROUP_CHAT_CREATED'].forEach((k) => {
      const ev = types[k];
      if (!ev) return;
      try { c.eventSource.on(ev, () => { setTimeout(onCharacterContextChanged, 280); }); } catch { /* ignore */ }
    });
  }
  document.addEventListener('click', () => setTimeout(syncBallVisibility, 80), true);
}
function pickImportFile() {
  if (!ui || !ui.file) return;
  ui.file.value = '';
  ui.file.click();
}
async function onImportFilePicked(ev) {
  const file = ev.target && ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const packs = parseImportFile(text);
    upsertLocalPacks(packs);
    toast('已导入 ' + packs.length + ' 件本地作品，可点「导入世界书」');
    renderRepo();
  } catch (e) {
    toast('导入文件失败：' + (e && e.message ? e.message : String(e)), true);
  }
}
function bindFabDrag(ball, panel) {
  const POS_KEY = 'hwf_fab_pos_v1';
  const DEFAULT_R = 8;
  const DEFAULT_B = 148;
  function size() {
    return { w: ball.offsetWidth || 96, h: ball.offsetHeight || 96 };
  }
  function clamp(right, bottom) {
    const s = size();
    const maxR = Math.max(8, (window.innerWidth || 360) - s.w - 8);
    const maxB = Math.max(8, (window.innerHeight || 640) - s.h - 8);
    return {
      right: Math.round(Math.min(maxR, Math.max(8, right))),
      bottom: Math.round(Math.min(maxB, Math.max(8, bottom))),
    };
  }
  function save() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        right: parseFloat(ball.style.right) || DEFAULT_R,
        bottom: parseFloat(ball.style.bottom) || DEFAULT_B,
      }));
    } catch { /* ignore */ }
  }
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && isFinite(Number(p.right)) && isFinite(Number(p.bottom))) {
        const c = clamp(Number(p.right), Number(p.bottom));
        ball.style.right = c.right + 'px';
        ball.style.bottom = c.bottom + 'px';
      }
    }
  } catch { /* ignore */ }
  let drag = null;
  ball.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      r: parseFloat(ball.style.right) || DEFAULT_R,
      b: parseFloat(ball.style.bottom) || DEFAULT_B,
    };
    try { ball.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  ball.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && (dx * dx + dy * dy) < 36) return;
    drag.moved = true;
    ball.classList.add('is-dragging');
    const c = clamp(drag.r - dx, drag.b - dy);
    ball.style.right = c.right + 'px';
    ball.style.bottom = c.bottom + 'px';
  });
  function endDrag(e) {
    if (!drag) return;
    const moved = drag.moved;
    try { if (e) ball.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    ball.classList.remove('is-dragging');
    if (moved) {
      save();
      ball.dataset.dragged = '1';
      if (e && e.preventDefault) e.preventDefault();
    }
    drag = null;
  }
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', () => {
    drag = null;
    ball.classList.remove('is-dragging');
  });
  window.addEventListener('resize', () => {
    const c = clamp(parseFloat(ball.style.right) || DEFAULT_R, parseFloat(ball.style.bottom) || DEFAULT_B);
    ball.style.right = c.right + 'px';
    ball.style.bottom = c.bottom + 'px';
  });
  ball.addEventListener('click', (e) => {
    if (ball.dataset.dragged === '1') {
      delete ball.dataset.dragged;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (panel.classList.contains('open')) closeRepoPanel();
    else openRepoPanel();
  });
}
function buildRepo() {
  if (ui) return;
  if (!document.body) { setTimeout(buildRepo, 300); return; }
  const ball = document.createElement('button');
  ball.id = 'hwf-fab';
  ball.type = 'button';
  ball.className = 'hwf-ball';
  ball.title = 'hotaru-workshop · 我的仓库';
  ball.setAttribute('aria-label', '打开荧荧工坊本地仓库');
  ball.setAttribute('data-hidden', '1');
  ball.innerHTML = '<span class="hwf-atom" aria-hidden="true"><span class="hwf-orbit o1"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-orbit o2"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-orbit o3"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-nucleus"><span class="hwf-nucleus-core"></span><span class="hwf-nucleus-shine"></span></span></span><span class="hwf-fab-badge" data-badge hidden>!</span>';
  const veil = document.createElement('div');
  veil.className = 'hwf-veil';
  veil.setAttribute('aria-hidden', 'true');
  const panel = document.createElement('div');
  panel.className = 'hwf-repo';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '荧荧工坊本地仓库');
  panel.innerHTML = `
    <button type="button" class="hwf-close" id="hwf-close" aria-label="关闭">×</button>
    <div class="hwf-repo-head">我的仓库 <span class="hwf-repo-sub">hotaru-workshop v${EXT_VERSION} · 荧荧工坊 <span class="hwf-update-badge" data-badge hidden>有更新</span></span></div>
    <div class="hwf-repo-body">
      <div class="hwf-repo-login" id="hwf-login"></div>
      <div class="hwf-repo-actions">
        <button class="hwf-btn hwf-btn-main" id="hwf-open">进入荧荧工坊</button>
        <button class="hwf-btn" id="hwf-import">导入文件</button>
        <button class="hwf-btn" id="hwf-check">检查更新</button>
        <button class="hwf-btn" id="hwf-update" data-update hidden>更新荧荧工坊</button>
      </div>
      <div class="hwf-update-line" data-status></div>
      <div class="hwf-repo-list" id="hwf-list"></div>
    </div>
    <div class="hwf-loading">加载中…</div>`;
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.style.display = 'none';
  document.body.append(ball, veil, panel, file);
  ui = { ball, veil, panel, file, login: panel.querySelector('#hwf-login'), list: panel.querySelector('#hwf-list'), loading: panel.querySelector('.hwf-loading') };
  bindFabDrag(ball, panel);
  veil.addEventListener('click', closeRepoPanel);
  panel.querySelector('#hwf-close').addEventListener('click', closeRepoPanel);
  panel.querySelector('#hwf-open').addEventListener('click', () => { window.open(settings.gateway + '?from=' + encodeURIComponent(location.origin), '_blank'); });
  panel.querySelector('#hwf-import').addEventListener('click', pickImportFile);
  panel.querySelector('#hwf-check').addEventListener('click', () => checkUpdate(panel, false));
  panel.querySelector('#hwf-update').addEventListener('click', () => doUpdate(panel));
  file.addEventListener('change', onImportFilePicked);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closeRepoPanel(); });
  syncBallVisibility();
}
function rowHtml(p, local) {
  const author = (p.publisher && p.publisher.displayName) ? p.publisher.displayName : '匿名';
  return `
      <div class="hwf-row">
        <div class="hwf-row-info"><div class="hwf-row-title">${esc(p.title)}${local ? ' <span class="hwf-local">本地文件</span>' : ''}</div><div class="hwf-row-sub">${esc(author)} · ${esc(p.category || p.type || '')}</div></div>
        <button class="hwf-mini" data-imp="${esc(p.id)}" ${local ? 'data-local="1"' : ''}>导入世界书</button>
        <button class="hwf-mini hwf-mini-ghost" data-del="${esc(p.id)}" ${local ? 'data-local="1"' : ''}>移除</button>
      </div>`;
}
function bindRepoRows() {
  ui.list.querySelectorAll('[data-imp]').forEach((b) => b.onclick = () => {
    if (b.dataset.local === '1') {
      const p = findLocalPack(b.dataset.imp);
      if (!p) { toast('本地作品不存在', true); return; }
      importPackage(p);
      return;
    }
    apiDetail(b.dataset.imp).then((x) => importPackage(x.package)).catch((e) => toast('读取作品失败：' + e.message, true));
  });
  ui.list.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    if (b.dataset.local === '1') { removeLocalPack(b.dataset.del); toast('已移除本地文件'); renderRepo(); return; }
    apiDlDel(b.dataset.del).then(() => { toast('已移除'); renderRepo(); }).catch((e) => toast('移除失败：' + e.message, true));
  });
}
function renderRepo() {
  if (!ui) return;
  const av = settings.user && settings.user.avatar
    ? 'https://cdn.discordapp.com/avatars/' + encodeURIComponent(settings.user.id) + '/' + encodeURIComponent(settings.user.avatar) + '.png?size=64' : '';
  ui.login.innerHTML = settings.user
    ? (av ? '<img class="hwf-avatar" src="' + av + '" alt="">' : '') + '<span>' + esc(settings.user.displayName || settings.user.username) + (settings.admin ? ' · 管理员' : '') + '</span> <button class="hwf-mini" id="hwf-logout">退出</button>'
    : '<span>未登录也可以「导入文件」；云端下载列表需要登录</span> <button class="hwf-mini" id="hwf-login-btn">Discord 登录</button>';
  const lo = ui.login.querySelector('#hwf-logout'); if (lo) lo.onclick = logout;
  const lb = ui.login.querySelector('#hwf-login-btn'); if (lb) lb.onclick = beginLogin;
  const local = loadLocalPacks();
  const paintLocal = (cloud) => {
    const cloudList = cloud || [];
    const cloudIds = new Set(cloudList.map((p) => String(p.id)));
    const localOnly = local.filter((p) => !cloudIds.has(String(p.id)));
    const html = localOnly.map((p) => rowHtml(p, true)).join('') + cloudList.map((p) => rowHtml(p, false)).join('');
    if (!html) {
      ui.list.innerHTML = settings.user
        ? '<div class="hwf-empty">还没有下载内容\n去云端工坊逛逛，或点「导入文件」</div>'
        : '<div class="hwf-empty">点「导入文件」，把网页工坊导出的 JSON 加进来\n无需登录也能导入世界书</div>';
      return;
    }
    ui.list.innerHTML = html;
    bindRepoRows();
  };
  if (!settings.user) { paintLocal([]); return; }
  ui.list.innerHTML = '<div class="hwf-empty">加载中…</div>';
  apiDownloads().then((d) => paintLocal(d.downloads || [])).catch((e) => {
    if (local.length) { paintLocal([]); toast('云端列表读取失败，仍显示本地文件', true); }
    else ui.list.innerHTML = '<div class="hwf-empty">读取失败：' + esc(e.message) + '</div>';
  });
}

/* ---------- 扩展条目设置卡片（星海式） ---------- */
let settingsMounted = false;
async function reqHeaders() {
  try { const mod = await import('/script.js'); if (mod && typeof mod.getRequestHeaders === 'function') return mod.getRequestHeaders(); } catch { }
  return { 'Content-Type': 'application/json' };
}
async function findInstall() {
  try {
    const res = await fetch('/api/extensions/discover');
    const list = await res.json();
    const hit = (list || []).find((x) => {
      const n = String(x && x.name || '');
      return n === 'hotaru-workshop' || n === '/hotaru-workshop' || /(?:^|\/)hotaru-workshop$/.test(n);
    });
    if (!hit) return null;
    let name = String(hit.name || 'hotaru-workshop');
    if (name.indexOf('third-party') === 0) name = name.replace('third-party', '');
    return { extensionName: name, global: String(hit.type || '') === 'global' };
  } catch { return null; }
}
function applyUpdateChrome(has, message, canGitUpdate) {
  const roots = [];
  const settingsPanel = document.getElementById('hwf-ext-settings');
  if (settingsPanel) roots.push(settingsPanel);
  if (ui && ui.panel) roots.push(ui.panel);
  for (const root of roots) {
    const badge = root.querySelector('[data-badge]');
    const btn = root.querySelector('[data-update]');
    const status = root.querySelector('[data-status]');
    if (badge) badge.hidden = !has;
    if (btn) btn.hidden = !(has && canGitUpdate);
    if (status && message != null) status.textContent = message;
  }
  if (ui && ui.ball) {
    const fabBadge = ui.ball.querySelector('[data-badge]');
    if (fabBadge) fabBadge.hidden = !has;
  }
}
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
async function checkGithubManifest() {
  const urls = [
    'https://cdn.jsdelivr.net/gh/lumine-423/hotaru-workshop@main/manifest.json',
    'https://raw.githubusercontent.com/lumine-423/hotaru-workshop/main/manifest.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.version) return cmpVer(data.version, EXT_VERSION) > 0;
    } catch { /* try next */ }
  }
  return null;
}
async function checkUpdate(panel, quiet) {
  const status = (panel && panel.querySelector('[data-status]')) || (ui && ui.panel && ui.panel.querySelector('[data-status]'));
  if (!quiet && status) status.textContent = '正在检查 GitHub 更新…';
  try {
    const install = await findInstall();
    if (install) {
      const res = await fetch('/api/extensions/version', { method: 'POST', headers: await reqHeaders(), body: JSON.stringify(install) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data && data.remoteUrl) {
        const has = data.isUpToDate === false;
        applyUpdateChrome(has, has ? '发现新版本，点「更新荧荧工坊」' : ('已是最新 · v' + EXT_VERSION), true);
        return has;
      }
    }
    const gh = await checkGithubManifest();
    if (gh === true) {
      applyUpdateChrome(true, '发现新版本。请用酒馆「从 URL 安装」更新，或点「更新荧荧工坊」（需 Git 安装）。', false);
      return true;
    }
    if (gh === false) {
      applyUpdateChrome(false, '已是最新 · v' + EXT_VERSION, false);
      return false;
    }
    applyUpdateChrome(false, '当前不是 Git 安装；从 GitHub 安装一次后即可自动提示更新。', false);
    return false;
  } catch (e) {
    if (!quiet && status) status.textContent = '检查更新失败：' + (e && e.message ? e.message : String(e));
    return false;
  }
}
async function doUpdate(panel) {
  const status = panel && panel.querySelector('[data-status]');
  const btn = panel && panel.querySelector('[data-update]');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  try {
    const install = await findInstall();
    if (!install) throw new Error('没有找到 Git 安装记录');
    const res = await fetch('/api/extensions/update', { method: 'POST', headers: await reqHeaders(), body: JSON.stringify(install) });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (status) status.textContent = data && data.isUpToDate ? '已经是最新版本。' : '更新完成，正在刷新…';
    if (data && !data.isUpToDate) setTimeout(() => { try { location.reload(); } catch { } }, 700);
  } catch (e) {
    if (status) status.textContent = '更新失败：' + (e && e.message ? e.message : String(e));
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '更新荧荧工坊'; }
  }
}
function mountSettingsPanel() {
  if (settingsMounted) return true;
  const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if (!host) return false;
  if (document.getElementById('hwf-ext-settings')) { settingsMounted = true; return true; }
  const panel = document.createElement('div');
  panel.id = 'hwf-ext-settings';
  panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>hotaru-workshop · 荧荧工坊 <span class="hwf-ext-version">v${EXT_VERSION}</span> <span class="hwf-update-badge" data-badge hidden>有更新</span></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="hwf-ext-actions"><button type="button" class="menu_button" data-repo>打开本地仓库</button><button type="button" class="menu_button" data-open>进入荧荧工坊</button><button type="button" class="menu_button" data-check>检查更新</button><button type="button" class="menu_button" data-update hidden>更新荧荧工坊</button></div><small data-status>正在读取版本状态…</small></div></div>`;
  host.appendChild(panel);
  panel.querySelector('[data-repo]').addEventListener('click', () => openRepoPanel());
  panel.querySelector('[data-open]').addEventListener('click', () => { window.open(settings.gateway + '?from=' + encodeURIComponent(location.origin), '_blank'); });
  panel.querySelector('[data-check]').addEventListener('click', () => checkUpdate(panel, false));
  panel.querySelector('[data-update]').addEventListener('click', () => doUpdate(panel));
  settingsMounted = true;
  setTimeout(() => checkUpdate(panel, true), 800);
  try {
    panel.__hwfUpdateTimer = setInterval(() => {
      if (!panel.isConnected) { clearInterval(panel.__hwfUpdateTimer); return; }
      checkUpdate(panel, true);
    }, 30 * 60 * 1000);
  } catch { /* ignore */ }
  return true;
}

/* ---------- 启动 ---------- */
function startup() {
  if (started) { buildRepo(); syncBallVisibility(); mountSettingsPanel(); return; }
  if (!window.SillyTavern || !window.SillyTavern.getContext) { setTimeout(startup, 400); return; }
  started = true;
  loadSettings();
  buildRepo();
  /* 与云端网页双向登录同步（postMessage；网页由本插件打开，opener 即本页） */
  const webOrigin = (() => { try { return new URL(settings.gateway).origin; } catch { return ''; } })();
  window.addEventListener('message', (ev) => {
    if (!webOrigin || ev.origin !== webOrigin) return;
    registerWebWindow(ev.source);
    const d = ev.data || {};
    if (d.type === 'hw-token-request') {
      try { ev.source.postMessage({ type: 'hw-token', token: settings.token || '', user: settings.user || null, admin: !!settings.admin }, ev.origin); } catch (e) { /* ignore */ }
    } else if (d.type === 'hw-auth-changed') {
      if (!d.token) return; /* 只接受「登录」广播；退出统一走服务器撤销 + 轮询，避免陈旧空回复误踢 */
      const changed = (settings.token || '') !== (d.token || '');
      settings.token = d.token; settings.user = d.user || null; settings.admin = !!d.admin; saveSettings();
      if (changed) { toast('已同步网页登录 · ' + ((d.user && d.user.displayName) || '')); renderRepo(); }
    }
  });
  if (handleAuthError() || location.hash.includes('mf-auth=')) { finishLoginFromHash(); }
  renderRepo();
  mountSettingsPanel();
  startAuthPolling();
  bindBallVisibilityEvents();
  syncBallVisibility();
  setTimeout(syncBallVisibility, 1200);
  setTimeout(() => checkUpdate(ui && ui.panel, true), 1000);
  setInterval(syncBallVisibility, 1000);
  setInterval(mountSettingsPanel, 2000);
}

/* ---------- 登录状态轮询校准（cookie 桥，不依赖窗口关系） ---------- */
let authPollTimer = null;
function startAuthPolling() {
  if (authPollTimer) return;
  authPollTimer = setInterval(syncAuthState, 15000);
  setTimeout(syncAuthState, 3000);
}
async function syncAuthState() {
  try {
    const me = await api('/api/workshop/me');
    if (me && me.loggedIn) {
      if (me.via === 'cookie') {
        // cookie 是权威（另一端最近登录）：本地 token 缓存作废，跟随 cookie 账号
        if (settings.token || !settings.user || String(settings.user.id) !== String(me.user.id) || settings.admin !== !!me.admin) {
          settings.token = ''; settings.user = me.user; settings.admin = !!me.admin; saveSettings(); notifyWeb(); renderRepo();
        }
      } else if (me.via === 'bearer' && (!settings.user || String(settings.user.id) !== String(me.user.id))) {
        settings.user = me.user; settings.admin = !!me.admin; saveSettings(); renderRepo();
      }
    }
  } catch (e) {
    // 服务器认为未登录（401）或账号被封禁（403）：清本地 —— 另一侧已退出 / 账号被处理
    // 注意：401 响应体是 errors:["login required"]，不能只看 "HTTP 401" 字样（旧 bug：永远匹配不上）
    if ((e && e.status === 401) || (e && e.status === 403) || (String(e && e.message ? e.message : '').indexOf('login required') >= 0) || (String(e && e.message ? e.message : '').indexOf('封禁') >= 0)) {
      if (settings.token || settings.user) {
        settings.token = ''; settings.user = null; settings.admin = false; saveSettings(); notifyWeb(); renderRepo();
        if (e && e.status === 403) toast('账号已被封禁：' + (e.message || ''), true);
      }
    }
  }
}

function tryBoot() {
  if (!window.SillyTavern || !window.SillyTavern.getContext) return false;
  const c = getCtx();
  if (c && c.eventSource && (c.eventTypes || c.event_types)) {
    const types = c.eventTypes || c.event_types;
    try { c.eventSource.on(types.APP_READY, startup); } catch { /* ignore */ }
  }
  startup();
  return true;
}
if (!tryBoot()) {
  let n = 0;
  const iv = setInterval(() => { n++; if (tryBoot() || n > 40) clearInterval(iv); }, 250);
}
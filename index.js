/*! hotaru-workshop v2.4.4 —— 本地仓库壳 + 云端荧荧工坊入口
 * 结构：悬浮球 = 本地仓库（只在角色卡 Magic Fairy 上显示，对照星海工坊绑「魔法少女MVU测试」）
 *       扩展条目 = 星海式设置卡片（打开仓库 / 进入工坊 / 检查更新 / 更新）
 *       真正的工坊 = 云端网页 https://workshop.hotaruworkshop.l.cd/
 */
const GATEWAY = 'https://workshop.hotaruworkshop.l.cd';
const WORLDBOOK = '群星的资料库 v4.0';
const NS = 'hotaruWorkshop';
const EXT_VERSION = '2.4.4';
const SOURCE_KIND = 'hotaru-workshop';
const ENTRY_MARK = '[hotaru]';

let settings = {};
let ui = null;
let healTimer = null;
const knownWebWindows = new Set(); /* 云端网页窗口登记：登录/退出时向其广播（postMessage 双向同步） */

function getCtx() {
  try {
    if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') return window.SillyTavern.getContext();
  } catch { /* ignore */ }
  return null;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isPhoneUi() {
  try {
    if (window.matchMedia('(max-width: 720px)').matches) return true;
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches && (window.innerWidth || 0) < 1100) return true;
  } catch { /* ignore */ }
  return (window.innerWidth || 0) <= 720;
}
function toast(msg, err) {
  let t = (ui && ui.root) ? ui.root.querySelector('.hwf-toast') : document.querySelector('.hwf-toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'hwf-toast';
    (ui && ui.root ? ui.root : document.documentElement).appendChild(t);
  }
  t.textContent = msg; t.classList.toggle('hwf-toast-error', !!err); t.classList.add('hwf-toast-show');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('hwf-toast-show'), 3200);
}
function getViewport() {
  try {
    const vv = window.visualViewport;
    if (vv && vv.width) return { w: Math.round(vv.width), h: Math.round(vv.height) };
  } catch { /* ignore */ }
  try {
    const de = document.documentElement;
    if (de && de.clientWidth) return { w: de.clientWidth, h: de.clientHeight };
  } catch { /* ignore */ }
  return { w: window.innerWidth || 360, h: window.innerHeight || 640 };
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
  settings.worldbook = WORLDBOOK;
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
function entryMetaOf(entry) {
  if (!entry) return null;
  for (const raw of [entry.automationId, entry.comment]) {
    if (!raw || typeof raw !== 'string') continue;
    const s = raw.trim();
    if (s.charAt(0) !== '{') continue;
    try { const p = JSON.parse(s); if (p && p.source === SOURCE_KIND) return p; } catch { /* ignore */ }
  }
  return null;
}
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
  return { uid: 0, displayIndex: 0, comment: '', disable: false, constant: false, selective: false, key: [], selectiveLogic: 0, keysecondary: [], scanDepth: null, vectorized: false, position: 1, role: null, depth: 4, order: 100, content: '', useProbability: true, probability: 100, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, sticky: null, cooldown: null, delay: null, addMemo: true, matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false, group: '', groupOverride: false, groupWeight: 100, caseSensitive: null, matchWholeWords: null, useGroupScoring: false, outletName: '', triggers: [], ignoreBudget: false, automationId: '' };
}
function wrapNamed(tag, body) {
  const inner = String(body || '').trim();
  if (!inner) return '';
  const open = '<' + tag + '>';
  if (inner.indexOf(open) !== -1) return inner;
  return open + '\n' + inner + '\n</' + tag + '>';
}
function findManaged(data) { const out = []; for (const [uidStr, entry] of Object.entries(data.entries || {})) { const m = entryMetaOf(entry); if (m) out.push({ uidStr, entry, meta: m }); } return out; }
function upsertEntry(data, name, patch) {
  for (const [uidStr, entry] of Object.entries(data.entries || {})) { const m = entryMetaOf(entry); if (m && m.name === name) { Object.assign(entry, patch); return entry; } }
  for (const entry of Object.values(data.entries || {})) {
    if (entry && String(entry.comment || '') === name) { Object.assign(entry, patch); return entry; }
  }
  const entry = entryTemplate(); let maxUid = -1, maxDisp = -1;
  for (const [uidStr, e] of Object.entries(data.entries || {})) { const n = parseInt(uidStr, 10); if (Number.isInteger(n) && n > maxUid) maxUid = n; if (Number.isInteger(e.displayIndex) && e.displayIndex > maxDisp) maxDisp = e.displayIndex; }
  entry.uid = maxUid + 1; entry.displayIndex = maxDisp + 1; data.entries[String(entry.uid)] = entry; Object.assign(entry, patch); return entry;
}
function stampEntry(entry, name, meta, fields) {
  entry.comment = name;
  entry.addMemo = true;
  entry.automationId = JSON.stringify(meta);
  Object.assign(entry, fields);
  return entry;
}
function blueOn(order) {
  return { disable: false, constant: true, selective: false, key: [], keysecondary: [], position: 1, depth: 4, order: order, probability: 100 };
}
function closedOff() {
  return { disable: true, constant: false, selective: false, key: [], keysecondary: [], position: 1, depth: 4, order: 100, probability: 100 };
}

/* 原版 11 个 DLC：控制器数组与速览必须固定保留，工坊角色只追加、不得覆盖 */
const FIXED_DLC_CHARS = ['沃露普塔', '莉比蒂妮', '库比蒂妮', '冬野秋夜殇', '冬野梦梦', '望月霞', '御影紫月', '无常', '夏雯', '夜海星', '夜星海'];
const FIXED_DLC_NAMES = new Set(FIXED_DLC_CHARS);
const FIXED_DLC_OVERVIEW = `DLC角色速览:
  简介：在这个世界的管理边缘地带，有一些不属于MF体系的少女们，她们独立于现有的体系，等待着{{user}}去发现，去邂逅。
  角色初始变量设置: 当角色初次登场后，按照以下格式写入stat_data/DLC/{角色名}/
  {角色名}:
    简介: string
    当前形态: string

  沃露普塔:
    阵营: 多子神神社
    简介: 月影村多子神神社圣女兼巫女，将性交视为呼吸般自然的生理本能。血色长发，粉色爱心瞳孔，幼童体型配早熟B罩杯乳房。
    邂逅解锁条件: 位于月影村
    形态:
      - 日常
      - 变身

  莉比蒂妮:
    阵营: 多子神神社
    简介: 月影村多子神神社见习巫女，库比蒂妮的双胞胎姐姐。活泼多话的黑皮少女，对自己极致的黑皮黑发黑瞳有微妙的自我厌恶。
    邂逅解锁条件: 位于月影村
    形态:
      - 日常
      - 变身

  库比蒂妮:
    阵营: 多子神神社
    简介: 月影村多子神神社见习巫女，莉比蒂妮的双胞胎妹妹。沉默寡言的白皮少女，对姐姐有近乎病态的依恋。
    邂逅解锁条件: 位于月影村
    形态:
      - 日常
      - 变身

  冬野秋夜殇:
    阵营: 永夜宫赌场
    简介: 永夜宫赌场千金小姐，慵懒腹黑的12岁少女。金银交织及腰长发，异色瞳（左金右银），91幼幼平台主播。
    邂逅解锁条件: 位于永夜宫赌场
    形态:
      - 日常
      - 变身

  冬野梦梦:
    阵营: 永夜宫赌场
    简介: 永夜宫赌场养女，小恶魔属性雌小鬼。黑蓝交织及肩发，异色瞳（左黑右蓝），91幼幼平台主播。
    邂逅解锁条件: 位于永夜宫赌场
    形态:
      - 日常
      - 变身

  望月霞:
    阵营: 望月流忍宗
    简介: 望月流忍者继承人，将色诱之术视为唯一信仰的偏执狂。雪白色高马尾，血色赤瞳，健康小麦色肌肤带清晰晒痕。
    邂逅解锁条件: 位于望月流忍宗领地
    形态:
      - 日常
      - 变身

  御影紫月:
    阵营: 永夜宫赌场
    简介: 百年难遇的天才少女，永夜宫赌场家庭教师。淡紫渐蓝极长双马尾，异色瞳（左紫右金），91幼幼平台主播。
    邂逅解锁条件: 位于永夜宫赌场
    形态:
      - 日常
      - 变身

  无常:
    阵营: 无（法则化身）
    简介: 死亡法则化身，冥土引渡者。表面9岁孩童形态，实际诞生仅4个月。额心倒三角印记，黑无常/白无常双形态切换。
    邂逅解锁条件: 特殊解锁角色，需有将死之人或亡魂在场
    形态:
      - 日常
      - 变身

  夏雯:
    阵营: 无（独居）
    简介: 父母双亡的10岁孤儿，独居别墅。黑发及脚带暗红挑染，暗红色爱心瞳孔。抖M淫荡少女，91幼幼平台主播。
    邂逅解锁条件: 随机偶遇，不设限制
    形态:
      - 日常
      - 变身

  夜海星:
    阵营: 无（前使魔）
    简介: 由海星型使魔吸收污秽魔力后意外拟人化。深海蓝发，暗黄横瞳，全身覆盖黏液和吸盘。91幼幼平台特邀猎奇主播。
    邂逅解锁条件: 随机偶遇，不设限制
    形态:
      - 日常
      - 变身

  夜星海:
    阵营: 无（小学生）
    简介: 新东京都海滨小学四年级学生，雌小鬼性格。淡蓝粉渐变的双马尾，粉色瞳孔，十岁孩童骨架配惊人G罩杯发育。
    邂逅解锁条件: 位于新东京都海滨
    形态:
      - 日常
      - 变身`;

function jsQuote(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function upsertShared(data, names, patch) {
  const nameList = Array.isArray(names) ? names : [names];
  for (const entry of Object.values(data.entries || {})) {
    const m = entryMetaOf(entry);
    if (m && nameList.indexOf(m.name) !== -1) { Object.assign(entry, patch); return entry; }
  }
  for (const entry of Object.values(data.entries || {})) {
    if (entry && nameList.indexOf(String(entry.comment || '')) !== -1) { Object.assign(entry, patch); return entry; }
  }
  return upsertEntry(data, nameList[0], patch);
}
function charControllerCode(names) {
  const list = (names || []).map(jsQuote).join(', ');
  return `@@preprocessing
<%
function getVal(path) {
    try {
        return getvar(path, { defaults: undefined });
    } catch(e) {
        return undefined;
    }
}
function exists(path) {
    return getVal(path) !== undefined;
}

var 在场角色 = getVal('stat_data.主角组.当前在场角色') || [];
if (!Array.isArray(在场角色)) {
    在场角色 = [];
}
function isPresent(charName) {
    return 在场角色.indexOf(charName) !== -1;
}

function isDLCUnlocked(charName) {
    return exists('stat_data.DLC.' + charName);
}

var dlcCharacters = [${list}];

var activated = [];

dlcCharacters.forEach(function(name) {
    if (isPresent(name) && isDLCUnlocked(name)) {
        activated.push('DLC/' + name);
    }
});

if (activated.length > 0) {
    for (var i = 0; i < activated.length; i++) {
%>
<rule_动态内容_<%= activated[i] %>>
<%- await getwi(activated[i]) %>
</rule_动态内容_<%= activated[i] %>>
<%
    }
}
%>`;
}
function formatExtraOverview(c) {
  const raw = String(c.overview || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (!raw) return '';
  const lines = raw.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = line.match(/^[ \t]*/);
    const n = lead ? lead[0].replace(/\t/g, '  ').length : 0;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map((line) => {
    if (!line.trim()) return '';
    const expanded = line.replace(/\t/g, '  ');
    const stripped = expanded.slice(0, min) === ' '.repeat(min) ? expanded.slice(min) : expanded.replace(/^[ \t]+/, '');
    return '  ' + stripped;
  }).join('\n');
}
function eventControllerCode(configs) {
  const lines = configs.map((c) => "    { id: '" + c.id.replace(/'/g, "\\'") + "', dlcChar: '" + String(c.dlcChar || '').replace(/'/g, "\\'") + "' }");
  return '@@preprocessing\n<%\nfunction getVal(path) {\n    try {\n        return getvar(path, { defaults: undefined });\n    } catch(e) {\n        return undefined;\n    }\n}\nfunction exists(path) {\n    return getVal(path) !== undefined;\n}\nfunction isCompleted(eventId) {\n    return getVal(\'stat_data.剧情事件.已完成事件.\' + eventId) === true;\n}\n\nvar activated = [];\n\n// ===== 在此填入你的DLC事件配置 =====\n// 每一项：{ id: \'剧情事件/xxx\', dlcChar: \'角色名\' }\nvar eventConfigs = [\n' + lines.join(',\n') + '\n];\neventConfigs.forEach(function(config) {\n    var eventId = config.id;\n    var dlcChar = config.dlcChar;\n    if (!isCompleted(eventId) && exists(\'stat_data.DLC角色.\' + dlcChar)) {\n        activated.push(eventId);\n    }\n});\n\nif (activated.length > 0) {\n    for (var i = 0; i < activated.length; i++) {\n%>\n<rule_动态内容_<%= activated[i] %>>\n<%- await getwi(activated[i]) %>\n</rule_动态内容_<%= activated[i] %>>\n<%\n    }\n}\n%>';
}
function metaOf(pkg, extra) { return { source: SOURCE_KIND, kind: 'workshop_package', series: pkg.series || 'mf', category: pkg.category || pkg.type, packageId: pkg.id, revision: pkg.revision, packageContentHash: pkg.contentHash, ...extra }; }
function applyPackageToWorldbook(data, pkg) {
  const cat = pkg.category || pkg.type;
  const extra = pkg.payload && pkg.payload.extra ? pkg.payload.extra : {};
  if (!['character', 'faction', 'event', 'gameplay', 'rule', 'other'].includes(cat)) throw new Error('该类型暂不支持导入（' + cat + '）');
  const base = metaOf(pkg, { name: '' });
  if (cat === 'character') {
    const roleNames = Array.isArray(extra.roleNames) && extra.roleNames.length ? extra.roleNames : [pkg.title];
    const overview = String(extra.overview || extra.intro || '');
    const archive = String(extra.archive || extra.daily || extra.content || extra.summary || '').trim();
    let wrote = 0;
    for (const rn of roleNames) {
      if (FIXED_DLC_NAMES.has(rn)) continue;
      wrote++;
      const name = 'DLC/' + rn;
      const entry = upsertEntry(data, name, {});
      stampEntry(entry, name, Object.assign({}, base, {
        name, roleNames: [rn], category: 'character',
        overview,
      }), Object.assign(closedOff(), {
        content: wrapNamed('DLC_' + rn, archive || overview),
      }));
    }
    if (!wrote) throw new Error('原版 DLC 角色已固定，不会覆盖「' + roleNames.join('、') + '」');
  } else if (cat === 'faction') {
    const name = 'DLC/' + pkg.title;
    const entry = upsertEntry(data, name, {});
    const keys = (Array.isArray(extra.keywords) && extra.keywords.length ? extra.keywords : [pkg.title]).slice(0, 20);
    const factionCount = findManaged(data).filter((x) => x.meta.category === 'faction').length;
    stampEntry(entry, name, Object.assign({}, base, { name, category: 'faction', keywords: extra.keywords || [] }), {
      content: String(extra.content || '').trim(),
      disable: false, constant: false, selective: true, key: keys, keysecondary: [],
      depth: 0, position: 1, order: 121 + factionCount, probability: 100,
    });
  } else if (cat === 'gameplay' || cat === 'rule' || cat === 'other') {
    const name = 'DLC/' + pkg.title;
    const entry = upsertEntry(data, name, {});
    stampEntry(entry, name, Object.assign({}, base, { name, category: cat }), Object.assign(blueOn(cat === 'gameplay' ? 131 : cat === 'rule' ? 141 : 151), {
      content: String(extra.content || '').trim(),
    }));
  } else if (cat === 'event') {
    const eventNames = Array.isArray(extra.eventNames) && extra.eventNames.length ? extra.eventNames : [pkg.title];
    const roleNames = Array.isArray(extra.roleNames) ? extra.roleNames : [];
    const contentText = String(extra.content || '').trim();
    for (const en of eventNames) {
      const name = '剧情事件/' + en;
      const entry = upsertEntry(data, name, {});
      stampEntry(entry, name, Object.assign({}, base, { name, category: 'event', eventName: en, roleNames }), Object.assign(closedOff(), {
        content: contentText,
      }));
    }
  }
}
function rebuildSharedEntries(data, pkg) {
  const base = metaOf(pkg || { series: 'mf', id: '', revision: 0, contentHash: '' }, {});
  const chars = findManaged(data).filter((it) => it.meta.category === 'character' && it.meta.name && it.meta.name.indexOf('DLC/') === 0 && it.meta.name !== 'DLC/角色速览' && it.meta.name !== 'DLC角色速览');
  const extras = [];
  const seen = new Set(FIXED_DLC_NAMES);
  for (const x of chars) {
    const rn = (x.meta.roleNames && x.meta.roleNames[0]) || String(x.meta.name || '').slice(4);
    if (!rn || seen.has(rn)) continue;
    seen.add(rn);
    extras.push({
      name: rn,
      overview: x.meta.overview || '',
    });
  }
  const extraBlocks = extras.map(formatExtraOverview).filter(Boolean);
  const overviewBody = extraBlocks.length
    ? FIXED_DLC_OVERVIEW + '\n\n' + extraBlocks.join('\n\n')
    : FIXED_DLC_OVERVIEW;
  const ov = upsertShared(data, ['DLC/角色速览', 'DLC角色速览'], {});
  stampEntry(ov, 'DLC/角色速览', Object.assign({}, base, { name: 'DLC/角色速览', category: 'character' }), Object.assign(blueOn(1001), {
    content: wrapNamed('DLC角色速览', overviewBody),
  }));
  const ctrl = upsertShared(data, ['DLC角色控制器'], {});
  stampEntry(ctrl, 'DLC角色控制器', Object.assign({}, base, { name: 'DLC角色控制器', category: 'character' }), Object.assign(blueOn(6), {
    content: charControllerCode(FIXED_DLC_CHARS.concat(extras.map((e) => e.name))),
  }));
  const configs = [];
  for (const x of findManaged(data).filter((it) => it.meta.category === 'event')) {
    if (x.meta.name && x.meta.name.indexOf('剧情事件/') === 0) {
      const charsBound = Array.isArray(x.meta.roleNames) ? x.meta.roleNames : [];
      if (charsBound.length) configs.push({ id: x.meta.name, dlcChar: charsBound[0] });
    }
  }
  if (configs.length) {
    const ev = upsertEntry(data, 'DLC剧情事件控制器', {});
    stampEntry(ev, 'DLC剧情事件控制器', Object.assign({}, base, { name: 'DLC剧情事件控制器', category: 'event' }), Object.assign(blueOn(7), {
      content: eventControllerCode(configs),
    }));
  }
}
async function importMany(pkgs) {
  const list = (pkgs || []).filter(Boolean);
  if (!list.length) { toast('没有可导入的作品', true); return; }
  if (!window.confirm('导入 ' + list.length + ' 件作品到世界书「' + settings.worldbook + '」？')) return;
  load(true);
  try {
    const data = await loadWorldbook();
    const skipped = [];
    for (const pkg of list) {
      try { applyPackageToWorldbook(data, pkg); }
      catch (e) { skipped.push((pkg.title || pkg.id || '') + '：' + (e && e.message ? e.message : String(e))); }
    }
    rebuildSharedEntries(data, list[0]);
    await saveWorldbook(data);
    toast('已导入 ' + (list.length - skipped.length) + ' 件' + (skipped.length ? '；跳过 ' + skipped.length + ' 件' : ''));
    if (skipped.length) toast(skipped.join('\n'), true);
    renderRepo();
  } catch (e) {
    toast('导入失败：' + e.message, true);
  } finally {
    load(false);
  }
}

/* ---------- 本地仓库悬浮窗 ---------- */
let started = false;
function load(on) { if (ui) ui.loading.style.display = on ? 'flex' : 'none'; }
function openRepoPanel() {
  if (!ui) buildRepo();
  if (!ui) return;
  syncPhoneChrome();
  ui.veil.classList.add('on');
  ui.panel.classList.add('open');
  try { if (isPhoneUi()) document.body.style.overflow = 'hidden'; } catch { /* ignore */ }
  renderRepo();
  syncBallVisibility();
}
function closeRepoPanel() {
  if (!ui) return;
  ui.veil.classList.remove('on');
  ui.panel.classList.remove('open');
  try { document.body.style.overflow = ''; } catch { /* ignore */ }
  syncBallVisibility();
}
function syncPhoneChrome() {
  const on = isPhoneUi();
  try { document.documentElement.classList.toggle('hwf-phone', on); } catch { /* ignore */ }
  if (ui && ui.root) ui.root.classList.toggle('hwf-phone', on);
  if (ui && ui.ball) ui.ball.classList.toggle('hwf-phone', on);
  if (ui && ui.panel) ui.panel.classList.toggle('hwf-phone', on);
  if (ui && ui.veil) ui.veil.classList.toggle('hwf-phone', on);
  if (ui && ui.panel) {
    const openBtn = ui.panel.querySelector('#hwf-open');
    if (openBtn) openBtn.textContent = on ? '打开工坊网页' : '进入荧荧工坊';
  }
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
function visibleCharName() {
  const sels = ['#rm_button_selected_ch', '#rm_button_selected_ch .ch_name', '.character_name_block', '#top-bar .ch_name', '#chat_header .name'];
  for (const s of sels) {
    try {
      const el = document.querySelector(s);
      const t = el && String(el.textContent || '').trim();
      if (t) return t;
    } catch { /* ignore */ }
  }
  return '';
}
function worldbookSelected() {
  try {
    const wi = document.querySelector('#world_info');
    if (!wi) return '';
    const opt = wi.options && wi.selectedIndex >= 0 ? wi.options[wi.selectedIndex] : null;
    return String((opt && (opt.text || opt.value)) || wi.value || '');
  } catch { return ''; }
}
function isCurrentWorkshopCard() {
  try { if (document.getElementById('hwf-workshop')) return true; } catch { /* ignore */ }
  try {
    if (isHostCardName(visibleCharName())) return true;
    if (String(worldbookSelected()).indexOf('群星的资料库') !== -1) return true;
  } catch { /* ignore */ }
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
  ui.root.dataset.open = panelOpen ? 'true' : 'false';
  ui.ball.setAttribute('data-hidden', on ? '0' : '1');
  ui.ball.setAttribute('aria-hidden', on ? 'false' : 'true');
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
function readFileAsText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('读取失败'));
    r.readAsText(file);
  });
}
async function onImportFilePicked(ev) {
  const files = ev.target && ev.target.files ? [...ev.target.files] : [];
  if (!files.length) return;
  const packs = [];
  const failed = [];
  for (const file of files) {
    try {
      const text = await readFileAsText(file);
      packs.push(...parseImportFile(text));
    } catch (e) {
      failed.push((file && file.name ? file.name : '文件') + '：' + (e && e.message ? e.message : String(e)));
    }
  }
  if (packs.length) {
    upsertLocalPacks(packs);
    toast('已加入 ' + packs.length + ' 件本地作品，勾选后点「导入选中」写入世界书');
    renderRepo();
  }
  if (failed.length) toast(failed.join('\n'), true);
}
function bindFabDrag(ball, panel) {
  const POS_KEY = 'hwf_fab_pos_v3';
  const pad = 10;
  function size() {
    const n = isPhoneUi() ? 56 : 96;
    return { w: ball.offsetWidth || n, h: ball.offsetHeight || n };
  }
  function clampPos(left, top) {
    const s = size();
    const v = getViewport();
    return {
      left: Math.round(Math.min(Math.max(pad, left), Math.max(pad, v.w - s.w - pad))),
      top: Math.round(Math.min(Math.max(pad, top), Math.max(pad, v.h - s.h - pad))),
    };
  }
  function apply(left, top) {
    const c = clampPos(left, top);
    ball.style.left = c.left + 'px';
    ball.style.top = c.top + 'px';
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
    return c;
  }
  function defaultPos() {
    const s = size();
    const v = getViewport();
    return { left: v.w - s.w - 16, top: Math.round(v.h * 0.34) };
  }
  function load() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && isFinite(Number(p.left)) && isFinite(Number(p.top))) {
          apply(Number(p.left), Number(p.top));
          return;
        }
      }
    } catch { /* ignore */ }
    const d = defaultPos();
    apply(d.left, d.top);
  }
  function save() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: parseFloat(ball.style.left) || defaultPos().left,
        top: parseFloat(ball.style.top) || defaultPos().top,
      }));
    } catch { /* ignore */ }
  }
  load();
  let drag = null;
  const slop = () => (isPhoneUi() ? 16 : 8);
  function pt(e) {
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }
  function start(e) {
    if (e.type === 'mousedown') {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
    }
    const p = pt(e);
    drag = {
      x: p.x,
      y: p.y,
      moved: false,
      left: parseFloat(ball.style.left) || defaultPos().left,
      top: parseFloat(ball.style.top) || defaultPos().top,
    };
  }
  function move(e) {
    if (!drag) return;
    const p = pt(e);
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    if (!drag.moved && (dx * dx + dy * dy) < slop()) return;
    drag.moved = true;
    ball.classList.add('is-dragging');
    apply(drag.left + dx, drag.top + dy);
  }
  function end() {
    if (!drag) return;
    const moved = drag.moved;
    ball.classList.remove('is-dragging');
    if (moved) {
      save();
      ball.dataset.dragged = '1';
    }
    drag = null;
  }
  ball.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  ball.addEventListener('touchstart', start, { passive: true });
  window.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
  const reclamp = () => {
    syncPhoneChrome();
    apply(parseFloat(ball.style.left) || defaultPos().left, parseFloat(ball.style.top) || defaultPos().top);
  };
  window.addEventListener('resize', reclamp);
  try { if (window.visualViewport) window.visualViewport.addEventListener('resize', reclamp); } catch { /* ignore */ }
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
function hostEl() {
  return document.documentElement || document.body;
}
function healDom() {
  if (!ui || !ui.root) return;
  const host = hostEl();
  if (!host) return;
  if (ui.root.parentNode !== host) host.appendChild(ui.root);
}
function buildRepo() {
  if (ui) { healDom(); return; }
  const host = hostEl();
  if (!host) { setTimeout(buildRepo, 300); return; }
  const root = document.createElement('div');
  root.id = 'hwf-root';
  root.dataset.open = 'false';
  const ball = document.createElement('button');
  ball.id = 'hwf-fab';
  ball.type = 'button';
  ball.className = 'hwf-ball';
  ball.title = 'hotaru-workshop · 我的仓库';
  ball.setAttribute('aria-label', '打开荧荧工坊本地仓库');
  ball.setAttribute('data-hidden', '1');
  ball.innerHTML = '<span class="hwf-atom" aria-hidden="true"><span class="hwf-orbit o1"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-orbit o2"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-orbit o3"><span class="hwf-spin"><span class="hwf-electron"></span></span></span><span class="hwf-nucleus"><span class="hwf-nucleus-core"></span><span class="hwf-nucleus-shine"></span></span></span>';
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
    <div class="hwf-repo-head">我的仓库 <span class="hwf-repo-sub">hotaru-workshop v${EXT_VERSION} · 荧荧工坊</span></div>
    <div class="hwf-repo-body">
      <div class="hwf-repo-login" id="hwf-login"></div>
      <div class="hwf-repo-actions">
        <button class="hwf-btn hwf-btn-main" id="hwf-open">进入荧荧工坊</button>
        <button class="hwf-btn" id="hwf-import-sel">导入选中</button>
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
  file.accept = '.json,application/json,text/plain';
  file.multiple = true;
  file.className = 'hwf-file';
  file.setAttribute('aria-hidden', 'true');
  root.append(ball, veil, panel, file);
  host.appendChild(root);
  ui = { root, ball, veil, panel, file, login: panel.querySelector('#hwf-login'), list: panel.querySelector('#hwf-list'), loading: panel.querySelector('.hwf-loading') };
  syncPhoneChrome();
  bindFabDrag(ball, panel);
  veil.addEventListener('click', closeRepoPanel);
  panel.querySelector('#hwf-close').addEventListener('click', closeRepoPanel);
  panel.querySelector('#hwf-open').addEventListener('click', () => { window.open(settings.gateway + '?from=' + encodeURIComponent(location.origin), '_blank'); });
  panel.querySelector('#hwf-import-sel').addEventListener('click', importSelected);
  panel.querySelector('#hwf-import').addEventListener('click', pickImportFile);
  panel.querySelector('#hwf-check').addEventListener('click', () => checkUpdate(panel, false));
  panel.querySelector('#hwf-update').addEventListener('click', () => doUpdate(panel));
  file.addEventListener('change', onImportFilePicked);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closeRepoPanel(); });
  window.addEventListener('pageshow', healDom);
  if (!healTimer) healTimer = setInterval(healDom, 2000);
  syncBallVisibility();
}
function rowHtml(p, local) {
  const author = (p.publisher && p.publisher.displayName) ? p.publisher.displayName : '匿名';
  return `
      <div class="hwf-row">
        <label class="hwf-check"><input type="checkbox" data-sel="${esc(p.id)}" ${local ? 'data-local="1"' : ''}></label>
        <div class="hwf-row-info"><div class="hwf-row-title">${esc(p.title)}${local ? ' <span class="hwf-local">本地文件</span>' : ''}</div><div class="hwf-row-sub">${esc(author)} · ${esc(p.category || p.type || '')}</div></div>
        <button class="hwf-mini hwf-mini-ghost" data-del="${esc(p.id)}" ${local ? 'data-local="1"' : ''}>移除</button>
      </div>`;
}
async function importSelected() {
  if (!ui) return;
  const boxes = [...ui.list.querySelectorAll('input[data-sel]:checked')];
  if (!boxes.length) { toast('请先勾选要导入的作品', true); return; }
  const pkgs = [];
  for (const b of boxes) {
    const id = b.dataset.sel;
    if (b.dataset.local === '1') {
      const p = findLocalPack(id);
      if (!p) { toast('本地作品不存在：' + id, true); continue; }
      pkgs.push(p);
      continue;
    }
    try {
      const x = await apiDetail(id);
      if (x && x.package) pkgs.push(x.package);
    } catch (e) {
      toast('读取失败：' + (e && e.message ? e.message : String(e)), true);
    }
  }
  await importMany(pkgs);
}
function bindRepoRows() {
  ui.list.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    if (b.dataset.local === '1') { removeLocalPack(b.dataset.del); toast('已移除本地文件'); renderRepo(); return; }
    apiDlDel(b.dataset.del).then(() => { toast('已移除'); renderRepo(); }).catch((e) => toast('移除失败：' + e.message, true));
  });
}
function renderRepo() {
  if (!ui) return;
  syncPhoneChrome();
  const phone = isPhoneUi();
  const av = settings.user && settings.user.avatar
    ? 'https://cdn.discordapp.com/avatars/' + encodeURIComponent(settings.user.id) + '/' + encodeURIComponent(settings.user.avatar) + '.png?size=64' : '';
  if (phone) {
    ui.login.innerHTML = settings.user
      ? (av ? '<img class="hwf-avatar" src="' + av + '" alt="">' : '') + '<span>' + esc(settings.user.displayName || settings.user.username) + (settings.admin ? ' · 管理员' : '') + '</span>'
      : '<span>手机请先在工坊网页点「导出文件」，再点「导入文件」。无需登录。</span>';
  } else {
    ui.login.innerHTML = settings.user
      ? (av ? '<img class="hwf-avatar" src="' + av + '" alt="">' : '') + '<span>' + esc(settings.user.displayName || settings.user.username) + (settings.admin ? ' · 管理员' : '') + '</span> <button class="hwf-mini" id="hwf-logout">退出</button>'
      : '<span>未登录也可以「导入文件」；云端下载列表需要登录</span> <button class="hwf-mini" id="hwf-login-btn">Discord 登录</button>';
  }
  const lo = ui.login.querySelector('#hwf-logout'); if (lo) lo.onclick = logout;
  const lb = ui.login.querySelector('#hwf-login-btn'); if (lb) lb.onclick = beginLogin;
  const local = loadLocalPacks();
  const paintLocal = (cloud) => {
    const cloudList = cloud || [];
    const cloudIds = new Set(cloudList.map((p) => String(p.id)));
    const localOnly = local.filter((p) => !cloudIds.has(String(p.id)));
    const html = localOnly.map((p) => rowHtml(p, true)).join('') + cloudList.map((p) => rowHtml(p, false)).join('');
    if (!html) {
      ui.list.innerHTML = phone
        ? '<div class="hwf-empty">点「打开工坊网页」导出 JSON，再点「导入文件」加进仓库\n勾选后点「导入选中」写入世界书</div>'
        : (settings.user
          ? '<div class="hwf-empty">还没有下载内容\n去云端工坊逛逛，或点「导入文件」</div>'
          : '<div class="hwf-empty">点「导入文件」，把网页工坊导出的 JSON 加进来\n无需登录也能导入世界书</div>');
      return;
    }
    ui.list.innerHTML = html;
    bindRepoRows();
  };
  if (!settings.user || phone) { paintLocal([]); return; }
  ui.list.innerHTML = '<div class="hwf-empty">加载中…</div>';
  apiDownloads().then((d) => paintLocal(d.downloads || [])).catch((e) => {
    if (local.length) { paintLocal([]); toast('云端列表读取失败，仍显示本地文件', true); }
    else ui.list.innerHTML = '<div class="hwf-empty">读取失败：' + esc(e.message) + '</div>';
  });
}

/* ---------- 扩展条目设置卡片 ---------- */
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
    const btn = root.querySelector('[data-update]');
    const status = root.querySelector('[data-status]');
    if (btn) btn.hidden = !(has && canGitUpdate);
    if (status && message != null) status.textContent = message;
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
      applyUpdateChrome(true, '发现新版本。请用酒馆扩展列表更新，或点「更新荧荧工坊」（需 Git 安装）。', false);
      return true;
    }
    if (gh === false) {
      applyUpdateChrome(false, '已是最新 · v' + EXT_VERSION, false);
      return false;
    }
    applyUpdateChrome(false, '当前不是 Git 安装；从 GitHub 安装一次后即可在本页更新。', false);
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
  panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>hotaru-workshop · 荧荧工坊 <span class="hwf-ext-version">v${EXT_VERSION}</span></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="hwf-ext-actions"><button type="button" class="menu_button" data-repo>打开本地仓库</button><button type="button" class="menu_button" data-open>进入荧荧工坊</button><button type="button" class="menu_button" data-check>检查更新</button><button type="button" class="menu_button" data-update hidden>更新荧荧工坊</button></div><small data-status></small></div></div>`;
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
  syncPhoneChrome();
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
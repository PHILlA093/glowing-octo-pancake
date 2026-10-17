/* ============================================================
 * store.js — 本地存储（全部留在手机上，不上传）
 * ------------------------------------------------------------
 * 数据都在 localStorage，卸载即消失。没有账号，没有云端。
 * 这是产品承诺的一部分：他说的话不该离开这台手机。
 * ============================================================ */
'use strict';

const KEY = 'nuanyu.v1';

const DEFAULT = {
  v: 1,
  profile: {
    companionId: 'yu',
    autoSpeak: false,     // 自动朗读回复
    rate: 0.92,           // 语速
    pitch: 1.0,
    lang: 'zh-CN',
    night: false,         // 夜间模式
    calm: false,          // 陪伴模式（呼吸 + 环境音）
    // 门：他自己按下的"可以问一句"。
    // 默认关。开一次只活一轮/15 分钟，用掉或超时自己关上。
    // 这不是性格设置，是一次性的许可 —— 所以不给它做"永远开着"的选项。
    askOpen: false,
    askUntil: 0
  },
  ai: {
    // 默认选免费那家：新用户装完只要去注册个号、粘个 Key 就能聊，
    // 不用先充值、也不用梯子。想更自然可以去「我的」切 DeepSeek。
    providerId: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    apiKey: '',
    temperature: 1.3,
    maxTokens: 400
  },
  chats: {},              // companionId -> [{role,text,ts,crisis}]
  moods: [],              // [{ts, mood}]  mood: 1..5
  traces: [],             // [{ts, mood, text}]
  likes: [],              // 记住的偏好（只用于让他舒服，不翻旧账）
  firstOpen: 0,
  lastOpen: 0
};

let state = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function load() {
  if (state) return state;
  let savedAi = null;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    savedAi = (parsed && parsed.ai) || null;
    state = parsed ? Object.assign(clone(DEFAULT), parsed) : clone(DEFAULT);
    // 深合并容易漏，逐块兜底
    state.profile = Object.assign(clone(DEFAULT.profile), state.profile || {});
    state.ai = Object.assign(clone(DEFAULT.ai), state.ai || {});
    state.chats = state.chats || {};
    state.moods = state.moods || [];
    state.traces = state.traces || [];
    state.likes = state.likes || [];
  } catch (e) {
    state = clone(DEFAULT);
    savedAi = null;
  }

  // 升级兼容：v5 之前没有 providerId 这个字段。
  // 不能让它被默认值（免费那家）覆盖 —— 老用户填的是 DeepSeek 的地址，
  // 硬套默认会导致"卡片显示智谱已选中、实际还在连 DeepSeek"这种
  // 界面与实际不符的静默错误。按他自己填的地址反推才对。
  if (!savedAi || !savedAi.providerId) {
    const guess = window.Providers
      ? Providers.detectProvider(state.ai.baseUrl).id
      : 'custom';
    state.ai.providerId = guess;
  }

  const now = Date.now();
  if (!state.firstOpen) state.firstOpen = now;
  state.lastOpen = now;
  return state;
}

let saveTimer = null;
function save() {
  // 聊天流式输出时会被高频调用，做一次合并
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }, 220);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------- 聊天 ---------- */
const MAX_CHAT = 400;   // 每伙伴最多留 400 条，防 localStorage 撑爆

function chatOf(companionId) {
  const s = load();
  if (!s.chats[companionId]) s.chats[companionId] = [];
  return s.chats[companionId];
}

function pushChat(companionId, msg) {
  const list = chatOf(companionId);
  list.push(msg);
  if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
  save();
  return msg;
}

/** 取最近 n 轮作为上下文（越近越重要，倒序取回正序） */
function recentContext(companionId, n) {
  const list = chatOf(companionId).filter(m => m.text);
  return list.slice(-(n || 16)).map(m => ({ role: m.role, content: m.text }));
}

function clearChat(companionId) {
  const s = load();
  s.chats[companionId] = [];
  saveNow();
}

/* ---------- 心情打卡 / 痕迹 ---------- */
function addMood(mood) {
  const s = load();
  s.moods.push({ ts: Date.now(), mood: mood });
  if (s.moods.length > 3000) s.moods.splice(0, s.moods.length - 3000);
  saveNow();
}

function addTrace(trace) {
  const s = load();
  s.traces.push(trace);
  if (s.traces.length > 2000) s.traces.splice(0, s.traces.length - 2000);
  saveNow();
}

function removeTrace(ts) {
  const s = load();
  s.traces = s.traces.filter(t => t.ts !== ts);
  saveNow();
}

/** 今天是否已打过卡 */
function moodToday() {
  const s = load();
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  const hit = s.moods.filter(m => m.ts >= start);
  return hit.length ? hit[hit.length - 1].mood : 0;
}

/** 某天的心情（用于日历） */
function moodOnDay(y, m, d) {
  const s = load();
  const start = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const end = start + 86400000;
  const hit = s.moods.filter(x => x.ts >= start && x.ts < end);
  return hit.length ? hit[hit.length - 1].mood : 0;
}

function tracesOnDay(y, m, d) {
  const s = load();
  const start = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const end = start + 86400000;
  return s.traces.filter(x => x.ts >= start && x.ts < end);
}

/** 陪你走过多少天（有打卡或有痕迹的天数） */
function daysTogether() {
  const s = load();
  const set = new Set();
  s.moods.forEach(m => { const d = new Date(m.ts); set.add(d.toDateString()); });
  s.traces.forEach(t => { const d = new Date(t.ts); set.add(d.toDateString()); });
  return set.size;
}

/* ---------- 偏好记忆 ---------- */
function addLike(text) {
  const s = load();
  const t = String(text).trim().slice(0, 40);
  if (!t || s.likes.includes(t)) return;
  s.likes.push(t);
  if (s.likes.length > 30) s.likes.shift();
  saveNow();
}

function removeLike(text) {
  const s = load();
  s.likes = s.likes.filter(x => x !== text);
  saveNow();
}

/* ---------- 导出 / 清空 ---------- */
function exportAll() {
  return JSON.stringify(load(), null, 2);
}

function wipe() {
  state = clone(DEFAULT);
  state.firstOpen = Date.now();
  state.lastOpen = state.firstOpen;
  saveNow();
}

window.Store = {
  load, save, saveNow,
  chatOf, pushChat, recentContext, clearChat,
  addMood, addTrace, removeTrace, moodToday, moodOnDay, tracesOnDay, daysTogether,
  addLike, removeLike, exportAll, wipe
};

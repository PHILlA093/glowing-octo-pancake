/* ============================================================
 * ui.js — 渲染与交互零件
 * ------------------------------------------------------------
 * 打卡选项刻意不用临床词：不写"焦虑/抑郁/压力大"，
 * 只写"挺好/还行/一般/难受/很糟"。
 * 标签会变成自我诊断，那不是陪伴该做的事。
 * ============================================================ */
'use strict';

function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

/* 心情档位：从好到坏。face 只表达程度，不表达诊断 */
const MOODS = [
  { v: 5, face: '😊', label: '挺好' },
  { v: 4, face: '🙂', label: '还行' },
  { v: 3, face: '😐', label: '一般' },
  { v: 2, face: '😔', label: '难受' },
  { v: 1, face: '😣', label: '很糟' }
];

function moodFace(v) {
  const m = MOODS.find(x => x.v === v);
  return m ? m.face : '';
}

/* ---------- 时间 ---------- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtDay(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - d) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (d.getFullYear() === t.getFullYear()) return fmtDay(ts);
  return d.getFullYear() + ' 年 ' + fmtDay(ts);
}

/* ---------- 心情行 ---------- */
function renderMoodRow(el, value, onPick) {
  el.innerHTML = '';
  MOODS.forEach(m => {
    const b = document.createElement('button');
    b.className = 'mood' + (value === m.v ? ' on' : '');
    b.innerHTML = '<span class="mood-face">' + m.face + '</span><span>' + m.label + '</span>';
    b.onclick = function () { onPick(m.v); };
    el.appendChild(b);
  });
}

/* ---------- 对话气泡 ---------- */
function createMsgEl(role, text, ts) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'me' : 'them');
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text || '';
  wrap.appendChild(b);
  if (ts) {
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = fmtTime(ts);
    wrap.appendChild(t);
  }
  return wrap;
}

function createTypingEl() {
  const wrap = document.createElement('div');
  wrap.className = 'msg them';
  wrap.innerHTML = '<div class="bubble"><span class="dots"><i></i><i></i><i></i></span></div>';
  return wrap;
}

function createCrisisInlineEl(card) {
  const el = document.createElement('div');
  el.className = 'crisis-inline';
  let html = '<div class="ct">' + esc(card.title) + '</div><div class="cb">' + esc(card.body) + '</div>';
  card.lines.forEach(function (l) {
    html += '<div class="cl"><svg class="ic"><use href="#i-phone"/></svg>'
      + esc(l.label) + ' <b>' + esc(l.number) + '</b></div>';
  });
  html += '<div class="cf">' + esc(card.foot) + '</div>';
  el.innerHTML = html;
  return el;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollBottom(elList, force) {
  const near = elList.scrollHeight - elList.scrollTop - elList.clientHeight < 140;
  if (near || force) elList.scrollTop = elList.scrollHeight;
}

/* ---------- 浮层 ---------- */
function openSheet(id) {
  $('#sheetMask').classList.add('show');
  $('#' + id).classList.add('show');
}

function closeSheets() {
  $('#sheetMask').classList.remove('show');
  $$('.sheet').forEach(s => s.classList.remove('show'));
}

/* ---------- 吐司 ---------- */
let toastTimer = null;
function toast(text, ms) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
}

/* ---------- 危机卡 ---------- */
function showCrisisModal(card) {
  $('#crisisTitle').textContent = card.title;
  $('#crisisBody').textContent = card.body;
  const box = $('#crisisLines');
  box.innerHTML = '';
  card.lines.forEach(function (l) {
    const d = document.createElement('div');
    d.className = 'crisis-line';
    d.innerHTML = '<svg class="ic"><use href="#i-phone"/></svg><div><span class="lb">'
      + esc(l.label) + '</span><b>' + esc(l.number) + '</b></div>';
    box.appendChild(d);
  });
  $('#crisisFoot').textContent = card.foot;
  $('#crisisMask').classList.add('show');
}

function hideCrisisModal() { $('#crisisMask').classList.remove('show'); }

window.UI = {
  $, $$, MOODS, moodFace, fmtTime, fmtDay, dayLabel,
  renderMoodRow, createMsgEl, createTypingEl, createCrisisInlineEl,
  esc, scrollBottom, openSheet, closeSheets, toast,
  showCrisisModal, hideCrisisModal
};

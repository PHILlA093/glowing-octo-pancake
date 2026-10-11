/* ============================================================
 * app.js — 暖屿主逻辑
 * ------------------------------------------------------------
 * 对话流向：
 *   用户输入 → 危机识别 → 插入危机卡（不阻断）
 *            → 有 Key：走 AI 流式（系统提示词已写死"只安慰不引导"）
 *            → 没 Key：走 Comfort 本地陪伴句
 * 两条路的输出都必须满足：不问句、不分析、不建议。
 * ============================================================ */
'use strict';

let currentCompanion = null;
let streaming = null;        // 当前流
let crisisShownThisRun = false;

/* ============================================================
 * 启动
 * ============================================================ */
function boot() {
  const s = Store.load();
  applyTheme(s.profile.night);
  currentCompanion = Persona.COMPANIONS.find(c => c.id === s.profile.companionId) || Persona.COMPANIONS[0];

  renderHome();
  renderChatHistory();
  renderTrace();
  renderMine();
  wireTabs();
  wireHome();
  wireChat();
  wireTrace();
  wireMine();
  wireVoice();

  // 首次打开：只留一句问候，不提问
  if (!Store.chatOf(currentCompanion.id).length) {
    const g = Persona.openingGreeting(new Date());
    Store.pushChat(currentCompanion.id, { role: 'assistant', text: g, ts: Date.now() });
    renderChatHistory();
  }
}

function applyTheme(night) {
  document.body.classList.toggle('night', !!night);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', night ? '#15171D' : '#FFF8F2');
  // 让安卓状态栏/导航栏跟着一起变，否则浅色页面上顶着一条灰栏
  try {
    if (window.NuanyuNative && window.NuanyuNative.setNightMode) {
      window.NuanyuNative.setNightMode(!!night);
    }
  } catch (e) {}
}

/* ============================================================
 * 导航
 * ============================================================ */
function go(tab) {
  UI.$$('.screen').forEach(s => s.classList.remove('is-active'));
  const el = UI.$('#scr-' + tab);
  if (el) el.classList.add('is-active');
  UI.$$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
  if (tab === 'chat') setTimeout(function () { UI.scrollBottom(UI.$('#msgList'), true); }, 30);
  if (tab === 'trace') renderTrace();
  if (tab === 'mine') renderMine();
}

function wireTabs() {
  UI.$$('.tab').forEach(t => { t.onclick = function () { go(t.dataset.tab); }; });
  UI.$$('[data-go]').forEach(b => { b.onclick = function () { go(b.dataset.go); }; });
}

/* ============================================================
 * 屿上（首页）
 * ============================================================ */
const MOOD_REPLY = {
  5: ['嗯，挺好。', '今天不错。', '看到你这样我也松一口气。'],
  4: ['还行就挺好。', '这样就可以了。'],
  3: ['一般也挺好。不用非要高兴。', '平平的也算一天。', '嗯。这样也行。'],
  2: ['难受就难受。我在这儿。', '不用装作没事。', '嗯，我在。'],
  1: ['很糟也没关系。我陪着你。', '今天很难，我知道。不用说话。', '我在这儿。你不用一个人待着。']
};

function renderHome() {
  const c = currentCompanion;
  UI.$('#orbName').textContent = c.name;
  UI.$('#chatName').textContent = c.name;

  const h = new Date().getHours();
  const greet = h < 5 ? '还没睡' : h < 11 ? '早' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';
  UI.$('#homeGreet').textContent = greet + '。';
  UI.$('#homeSub').textContent = h >= 23 || h < 5 ? '这个点还醒着，我在。' : '什么都不用说也行。';
  UI.$('#orbLine').textContent = Persona.openingGreeting(new Date());

  const today = Store.moodToday();
  UI.renderMoodRow(UI.$('#moodRow'), today, onMoodPick);
  UI.$('#checkinTitle').textContent = today ? '今天已经打过卡了。想改也行' : '此刻是什么感觉';
  if (today) UI.$('#checkinNote').textContent = '';
}

function onMoodPick(v) {
  Store.addMood(v);
  UI.renderMoodRow(UI.$('#moodRow'), v, onMoodPick);
  const note = UI.$('#checkinNote');
  // 只回一句安抚。绝不问"为什么"。
  note.textContent = Comfort.pick('mood' + v, MOOD_REPLY[v]);
  note.classList.add('show');
  renderTrace();
}

function wireHome() {
  UI.$('#btnQuickTrace').onclick = function () { openTraceSheet(); };
  UI.$('#btnCalm').onclick = toggleCalm;
}

/* ---------- 陪伴模式：呼吸 + 环境声（WebAudio 合成，零素材） ---------- */
let audioCtx = null, calmNodes = null;

function toggleCalm() {
  const on = !document.body.classList.contains('calm');
  document.body.classList.toggle('calm', on);
  UI.$('#calmLabel').textContent = on ? '就待着，不着急' : '就想待一会儿';
  if (on) {
    startAmbient();
    UI.toast('就这样待着。呼吸慢一点也行，不用跟着谁。', 4200);
  } else {
    stopAmbient();
  }
  const s = Store.load(); s.profile.calm = on; Store.save();
}

function startAmbient() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (calmNodes) return;

    // 粉噪声 → 低通 → 慢速起伏 = 像远处的海
    const len = audioCtx.sampleRate * 3;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.10;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.loop = true;

    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520;

    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.16, audioCtx.currentTime + 2.2);

    const lfo = audioCtx.createOscillator();
    lfo.frequency.value = 0.07;             // 约 14 秒一次起伏，接近呼吸
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain); lfoGain.connect(gain.gain);

    src.connect(lp); lp.connect(gain); gain.connect(audioCtx.destination);
    src.start(); lfo.start();
    calmNodes = { src, lfo, gain };
  } catch (e) { /* 静音也不影响陪伴 */ }
}

function stopAmbient() {
  if (!calmNodes) return;
  try {
    const t = audioCtx.currentTime;
    calmNodes.gain.gain.cancelScheduledValues(t);
    calmNodes.gain.gain.setValueAtTime(calmNodes.gain.gain.value, t);
    calmNodes.gain.gain.linearRampToValueAtTime(0, t + 0.7);
    const n = calmNodes;
    setTimeout(function () { try { n.src.stop(); n.lfo.stop(); } catch (e) {} }, 900);
  } catch (e) {}
  calmNodes = null;
}

/* ============================================================
 * 说话（聊天）
 * ============================================================ */
function renderChatHistory() {
  const list = UI.$('#msgList');
  list.innerHTML = '';
  const msgs = Store.chatOf(currentCompanion.id).slice(-80);
  let lastDay = '';
  msgs.forEach(function (m) {
    const dl = UI.dayLabel(m.ts);
    if (dl !== lastDay) {
      lastDay = dl;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dl;
      list.appendChild(sep);
    }
    if (m.crisis) {
      list.appendChild(UI.createCrisisInlineEl(Persona.CRISIS_CARD));
    } else {
      list.appendChild(UI.createMsgEl(m.role === 'user' ? 'user' : 'assistant', m.text, m.ts));
    }
  });
  UI.scrollBottom(list, true);
}

function wireChat() {
  const input = UI.$('#input');
  const send = UI.$('#btnSend');

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 116) + 'px';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMsg();
    }
  });
  send.onclick = function () { sendMsg(); };

  UI.$('#btnCompanion').onclick = function () { openCompanionSheet(); };
  UI.$('#btnChatMore').onclick = function () { openTraceSheet(); };

  UI.$('#btnSpeakToggle').onclick = function () {
    const s = Store.load();
    s.profile.autoSpeak = !s.profile.autoSpeak;
    Store.saveNow();
    syncSpeakIcon();
    UI.toast(s.profile.autoSpeak ? '以后它会把话念出来' : '不念了');
  };
  syncSpeakIcon();
}

function syncSpeakIcon() {
  const on = Store.load().profile.autoSpeak;
  const use = UI.$('#speakIcon');
  if (use) use.setAttribute('href', on ? '#i-sound' : '#i-mute');
  UI.$('#btnSpeakToggle').style.color = on ? 'var(--brand)' : '';
}

function sendMsg() {
  const input = UI.$('#input');
  const text = input.value.trim();
  if (!text) return;
  if (streaming) { try { streaming.abort(); } catch (e) {} streaming = null; }
  input.value = '';
  input.style.height = 'auto';
  UI.$('#listeningBar').classList.remove('show');
  submit(text);
}

function submit(text) {
  const list = UI.$('#msgList');
  const cid = currentCompanion.id;

  Store.pushChat(cid, { role: 'user', text: text, ts: Date.now() });
  list.appendChild(UI.createMsgEl('user', text, Date.now()));
  UI.scrollBottom(list, true);

  // 危机识别：先轻轻把号码放到他面前（不阻断，不说教）
  if (Persona.detectCrisis(text)) {
    Store.pushChat(cid, { role: 'assistant', crisis: true, text: '', ts: Date.now() });
    list.appendChild(UI.createCrisisInlineEl(Persona.CRISIS_CARD));
    UI.scrollBottom(list, true);
    if (!crisisShownThisRun) {
      crisisShownThisRun = true;
      setTimeout(function () { UI.showCrisisModal(Persona.CRISIS_CARD); }, 700);
    }
  }

  // 记住偏好（只记喜欢/怕这类，绝不记痛苦经历）
  harvestLike(text);

  const typing = UI.createTypingEl();
  list.appendChild(typing);
  UI.scrollBottom(list, true);

  if (!AI.hasKey()) {
    // 本地陪伴模式
    const wait = 420 + Math.random() * 520;
    setTimeout(function () {
      const r = Comfort.reply(text, currentCompanion);
      typing.remove();
      finishReply(cid, r);
    }, wait);
    return;
  }

  let acc = '';
  let bubbleEl = null;
  let first = true;

  const messages = [{ role: 'system', content: Persona.buildSystemPrompt(cid, { likes: Store.load().likes, now: new Date() }) }]
    .concat(Store.recentContext(cid, 16));

  streaming = AI.stream(messages, {
    onDelta: function (piece) {
      acc += piece;
      if (first) {
        first = false;
        typing.remove();
        bubbleEl = UI.createMsgEl('assistant', '');
        list.appendChild(bubbleEl);
      }
      const b = bubbleEl.querySelector('.bubble');
      b.textContent = acc;
      UI.scrollBottom(list, false);
    },
    onDone: function () {
      streaming = null;
      if (typing.parentNode) typing.remove();
      const finalText = acc.trim() || '我在。';
      finishReply(cid, finalText, bubbleEl);
    },
    onError: function (err) {
      streaming = null;
      if (typing.parentNode) typing.remove();
      if (bubbleEl && bubbleEl.parentNode) bubbleEl.remove();
      // 出错也保持住陪伴的角色，不把技术错误砸到用户脸上
      const fallback = Comfort.reply(text, currentCompanion);
      finishReply(cid, fallback);
      UI.toast('这次没连上，先用它自己的话陪你。' + String(err).slice(0, 40), 3400);
    }
  });
}

/**
 * @param {HTMLElement} [existing] 流式时已经在屏上的气泡，复用它避免闪一下
 */
function finishReply(cid, text, existing) {
  const list = UI.$('#msgList');
  const ts = Date.now();
  Store.pushChat(cid, { role: 'assistant', text: text, ts: ts });
  if (existing && existing.parentNode) {
    const b = existing.querySelector('.bubble');
    if (b) b.textContent = text;
    let t = existing.querySelector('.msg-time');
    if (!t) { t = document.createElement('div'); t.className = 'msg-time'; existing.appendChild(t); }
    t.textContent = UI.fmtTime(ts);
  } else {
    list.appendChild(UI.createMsgEl('assistant', text, ts));
  }
  UI.scrollBottom(list, true);
  if (Store.load().profile.autoSpeak) Voice.speak(text);
}

/* ============================================================
 * 从话里记住偏好（只记偏好，不记伤痛）
 * ============================================================ */
const LIKE_RE = [
  { re: /我(?:很|超|特别|最)?(?:喜欢|爱)([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g, prefix: '喜欢' },
  { re: /我(?:最)?(?:怕|害怕)([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g, prefix: '怕' },
  { re: /我(?:很)?(?:讨厌|不喜欢)([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g, prefix: '不喜欢' }
];
const LIKE_BLOCK = /[我你他她它们谁人]|死|痛|哭|难|累|烦|恨|病|疼|孤独/;

function harvestLike(text) {
  LIKE_RE.forEach(function (g) {
    let m;
    g.re.lastIndex = 0;
    while ((m = g.re.exec(text)) !== null) {
      const obj = (m[1] || '').trim();
      if (!obj || obj.length < 1) continue;
      if (LIKE_BLOCK.test(obj)) continue;   // 带人称或负面的，一律不记
      Store.addLike(g.prefix + obj);
    }
  });
}

/* ============================================================
 * 伙伴切换
 * ============================================================ */
function openCompanionSheet() {
  const box = UI.$('#sheetCompList');
  box.innerHTML = '';
  Persona.COMPANIONS.forEach(function (c) {
    const b = document.createElement('button');
    b.className = 'sheet-comp' + (c.id === currentCompanion.id ? ' on' : '');
    b.innerHTML = '<span class="dot" style="background:' + c.accent + '"></span><span>'
      + '<span class="nm">' + UI.esc(c.name) + '</span> '
      + '<span class="tg">' + UI.esc(c.tagline) + '</span>'
      + '<div class="ds">' + UI.esc(c.desc) + '</div></span>';
    b.onclick = function () {
      const s = Store.load();
      s.profile.companionId = c.id;
      Store.saveNow();
      currentCompanion = c;
      renderHome(); renderChatHistory(); renderMine();
      syncSpeakIcon();
      UI.closeSheets();
      // 换个伙伴不该是一次"面试"，只留一句问候
      if (!Store.chatOf(c.id).length) {
        Store.pushChat(c.id, { role: 'assistant', text: Persona.openingGreeting(new Date()), ts: Date.now() });
        renderChatHistory();
      }
    };
    box.appendChild(b);
  });
  UI.openSheet('sheetCompanion');
}

/* ============================================================
 * 痕迹
 * ============================================================ */
let calYear, calMonth, calSelected;

function renderTrace() {
  const now = new Date();
  if (calYear == null) { calYear = now.getFullYear(); calMonth = now.getMonth(); calSelected = now.getDate(); }

  UI.$('#statDays').textContent = Store.daysTogether();
  UI.$('#statTraces').textContent = Store.load().traces.length;

  UI.$('#calTitle').textContent = calYear + ' 年 ' + (calMonth + 1) + ' 月';
  const grid = UI.$('#calGrid');
  grid.innerHTML = '';

  const first = new Date(calYear, calMonth, 1);
  let lead = first.getDay() - 1;          // 周一为一周起点
  if (lead < 0) lead = 6;
  for (let i = 0; i < lead; i++) {
    const b = document.createElement('button');
    b.className = 'cal-cell blank';
    grid.appendChild(b);
  }
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  const today = new Date();
  for (let d = 1; d <= days; d++) {
    const b = document.createElement('button');
    b.className = 'cal-cell';
    b.textContent = d;
    b.dataset.day = d;
    if (d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear()) b.classList.add('today');
    if (d === calSelected) b.classList.add('sel');
    if (Store.moodOnDay(calYear, calMonth, d) || Store.tracesOnDay(calYear, calMonth, d).length) {
      const dot = document.createElement('span');
      dot.className = 'mark';
      b.appendChild(dot);
    }
    b.onclick = function () { calSelected = d; renderTrace(); };
    grid.appendChild(b);
  }
  renderDayList();
}

function renderDayList() {
  const box = UI.$('#dayList');
  box.innerHTML = '';
  const ts = new Date(calYear, calMonth, calSelected).getTime();
  const traces = Store.tracesOnDay(calYear, calMonth, calSelected);
  const mood = Store.moodOnDay(calYear, calMonth, calSelected);

  const head = document.createElement('div');
  head.className = 'day-head';
  head.textContent = UI.dayLabel(ts) + (mood ? ' · ' + UI.moodFace(mood) : '');
  box.appendChild(head);

  if (!traces.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = mood ? '这天只留了一个表情，没写字。也可以。' : '这天没有留下什么。没关系的。';
    box.appendChild(e);
    return;
  }
  traces.forEach(function (t) {
    const item = document.createElement('div');
    item.className = 'trace-item';
    const face = document.createElement('div');
    face.className = 'trace-face';
    face.textContent = UI.moodFace(t.mood) || '·';
    const body = document.createElement('div');
    body.className = 'trace-body';
    if (t.text) {
      const tx = document.createElement('div');
      tx.className = 'trace-text';
      tx.textContent = t.text;
      body.appendChild(tx);
    }
    const meta = document.createElement('div');
    meta.className = 'trace-meta';
    meta.textContent = UI.fmtTime(t.ts);
    body.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'trace-del';
    del.textContent = '删';
    del.onclick = function () { Store.removeTrace(t.ts); renderTrace(); };
    item.appendChild(face); item.appendChild(body); item.appendChild(del);
    box.appendChild(item);
  });
}

let traceMood = 0;

function pickTraceMood(v) {
  traceMood = v;
  UI.renderMoodRow(UI.$('#traceMoodRow'), v, pickTraceMood);
}

function openTraceSheet() {
  traceMood = Store.moodToday() || 0;
  UI.$('#traceText').value = '';
  UI.renderMoodRow(UI.$('#traceMoodRow'), traceMood, pickTraceMood);
  UI.openSheet('sheetTrace');
  // 故意不自动聚焦输入框：
  //   1) 一聚焦就弹键盘，浮层被挤满、上方遮罩只剩一条缝，关都难关；
  //   2) 更重要的是产品立场 —— "写下来"不该逼人动笔，
  //      只选一个心情、一个字不写，也可以留下这一天。
}

function wireTrace() {
  UI.$('#btnNewTrace').onclick = openTraceSheet;
  UI.$('#btnTraceCancel').onclick = function () { UI.closeSheets(); };
  UI.$('#btnTraceSave').onclick = function () {
    const text = UI.$('#traceText').value.trim();
    if (!text && !traceMood) { UI.toast('不写也没关系，这就当今天来过了。'); UI.closeSheets(); return; }
    Store.addTrace({ ts: Date.now(), mood: traceMood || 0, text: text });
    UI.closeSheets();
    renderTrace();
    UI.toast('留下了。你想看的时候它就在这儿。');
  };
  UI.$('#calPrev').onclick = function () {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    calSelected = 0; renderTrace();
  };
  UI.$('#calNext').onclick = function () {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    calSelected = 0; renderTrace();
  };
  UI.$('#sheetMask').onclick = function () { UI.closeSheets(); };
  UI.$('#btnCrisisClose').onclick = function () { UI.hideCrisisModal(); };
}

/* ============================================================
 * 我的
 * ============================================================ */
function renderMine() {
  const s = Store.load();

  const row = UI.$('#compRow');
  row.innerHTML = '';
  Persona.COMPANIONS.forEach(function (c) {
    const b = document.createElement('button');
    b.className = 'comp' + (c.id === currentCompanion.id ? ' on' : '');
    b.innerHTML = '<div class="comp-name">' + UI.esc(c.name) + '</div><div class="comp-tag">' + UI.esc(c.tagline) + '</div>';
    b.onclick = function () {
      s.profile.companionId = c.id;
      Store.saveNow();
      currentCompanion = c;
      renderHome(); renderChatHistory(); renderMine(); syncSpeakIcon();
    };
    row.appendChild(b);
  });

  UI.$('#setAutoSpeak').checked = !!s.profile.autoSpeak;
  UI.$('#setRate').value = s.profile.rate || 0.92;
  UI.$('#setLang').value = s.profile.lang || 'zh-CN';
  UI.$('#setNight').checked = !!s.profile.night;

  UI.$('#setKey').value = s.ai.apiKey || '';
  UI.$('#setModel').value = s.ai.model || '';
  UI.$('#setBase').value = s.ai.baseUrl || '';
  renderProviders();

  const vn = UI.$('#voiceNote');
  const asr = Voice.asrAvailable(), tts = Voice.ttsAvailable();
  vn.textContent = (asr ? '能听你说话' : '这个设备上听不了（识别服务不可用）')
    + ' · ' + (tts ? '能念出来' : '这个设备上念不出来');

  const ll = UI.$('#likeList');
  ll.innerHTML = '';
  if (!s.likes.length) {
    ll.innerHTML = '<div class="row-note">它现在还什么都没记住。</div>';
  } else {
    s.likes.forEach(function (k) {
      const chip = document.createElement('span');
      chip.className = 'like-chip';
      chip.innerHTML = UI.esc(k);
      const x = document.createElement('button');
      x.textContent = '×';
      x.onclick = function () { Store.removeLike(k); renderMine(); };
      chip.appendChild(x);
      ll.appendChild(chip);
    });
  }
}

/* ============================================================
 * 接口预设：一键切换
 * ------------------------------------------------------------
 * 默认那家是免费的。用户不需要懂 baseUrl 和 model 是什么，
 * 点一下就把地址和模型都填好，只剩"粘一个 Key"这件事要做。
 * ============================================================ */
function currentProvider() {
  const s = Store.load();
  if (s.ai.providerId) return Providers.getProvider(s.ai.providerId);
  // 老用户升级上来时没有 providerId，按已填的地址反推
  return Providers.detectProvider(s.ai.baseUrl);
}

function renderProviders() {
  const cur = currentProvider();
  const row = UI.$('#provRow');
  row.innerHTML = '';
  Providers.PROVIDERS.forEach(function (p) {
    const b = document.createElement('button');
    b.className = 'prov' + (p.id === cur.id ? ' on' : '');
    b.innerHTML = '<span class="prov-name">' + UI.esc(p.name) + '</span>'
      + '<span class="prov-tag">' + UI.esc(p.tag) + '</span>';
    b.onclick = function () { pickProvider(p.id); };
    row.appendChild(b);
  });
  UI.$('#provNote').textContent = cur.note;
  UI.$('#privacyNote').textContent = cur.privacy
    + ' Key 只存在这台手机里，App 也读不到你手机上的其他东西。'
    + (cur.keyUrl ? ' 去 ' + cur.keyUrl + ' 注册就能拿。' : '');
  UI.$('#keyLabel').textContent = 'API Key';
  UI.$('#setKey').placeholder = cur.keyHint || '没有也能用，只是它只会陪着';
}

function pickProvider(id) {
  const p = Providers.getProvider(id);
  const s = Store.load();
  const changed = s.ai.providerId !== p.id;
  s.ai.providerId = p.id;
  if (p.id !== 'custom') {
    // 自定义保留用户自己填的，其余一律套预设，免得还要手抄地址
    s.ai.baseUrl = p.baseUrl;
    s.ai.model = p.model;
  }
  Store.saveNow();
  renderMine();
  if (p.id === 'glm' && !AI.hasKey()) {
    UI.toast('换成免费的智谱了。去 open.bigmodel.cn 注册，把 Key 粘进来就能聊。', 4200);
  } else if (changed) {
    UI.toast('换成 ' + p.name + ' 了');
  }
}

function wireMine() {
  UI.$('#setAutoSpeak').onchange = function () {
    const s = Store.load(); s.profile.autoSpeak = this.checked; Store.saveNow(); syncSpeakIcon();
  };
  UI.$('#setRate').oninput = function () {
    const s = Store.load(); s.profile.rate = parseFloat(this.value); Store.save();
  };
  UI.$('#setLang').onchange = function () {
    const s = Store.load(); s.profile.lang = this.value; Store.saveNow();
  };
  UI.$('#setNight').onchange = function () {
    const s = Store.load(); s.profile.night = this.checked; Store.saveNow(); applyTheme(this.checked);
  };
  UI.$('#setKey').oninput = function () {
    const s = Store.load(); s.ai.apiKey = this.value.trim(); Store.save();
  };
  UI.$('#setModel').oninput = function () {
    const s = Store.load();
    s.ai.model = this.value.trim() || 'glm-4-flash';
    // 手改过地址/模型就不再算预设那家了，免得卡片高亮与实际不符
    s.ai.providerId = Providers.detectProvider(s.ai.baseUrl).id;
    Store.save();
  };
  UI.$('#setBase').oninput = function () {
    const s = Store.load();
    s.ai.baseUrl = this.value.trim() || 'https://open.bigmodel.cn/api/paas/v4';
    s.ai.providerId = Providers.detectProvider(s.ai.baseUrl).id;
    Store.save();
  };

  UI.$('#btnTestSpeak').onclick = function () {
    if (!Voice.ttsAvailable()) { UI.toast('这台设备没有可用的朗读引擎'); return; }
    Voice.speak('嗯。我在。');
    UI.toast('听到了吗？');
  };

  UI.$('#btnTestAI').onclick = async function () {
    const note = UI.$('#aiNote');
    if (!AI.hasKey()) { note.textContent = '还没填 Key。不填也能用，只是它只会陪着。'; return; }
    note.textContent = '在试……';
    const r = await AI.testConnection();
    note.textContent = r.msg;
  };

  UI.$('#btnExport').onclick = function () {
    const data = Store.exportAll();
    try {
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'nuanyu-backup.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      UI.toast('导出了。它只在你手上。');
    } catch (e) {
      UI.toast('这台设备导不出来，抱歉。');
    }
  };

  UI.$('#btnWipe').onclick = function () {
    if (!confirm('清空之后，它就不记得你了，说过的话也没了。确定吗？')) return;
    Store.wipe();
    crisisShownThisRun = false;
    currentCompanion = Persona.COMPANIONS[0];
    Store.pushChat(currentCompanion.id, { role: 'assistant', text: Persona.openingGreeting(new Date()), ts: Date.now() });
    applyTheme(false);
    renderHome(); renderChatHistory(); renderTrace(); renderMine(); syncSpeakIcon();
    UI.toast('清空了。重新开始也行。');
  };
}

/* ============================================================
 * 语音
 * ============================================================ */
function wireVoice() {
  const mic = UI.$('#btnMic');
  const bar = UI.$('#listeningBar');
  const barText = UI.$('#listeningText');
  const input = UI.$('#input');

  Voice.setHandlers({
    onState: function (st) {
      const on = st === 'listening' || st === 'starting';
      mic.classList.toggle('rec', on);
      bar.classList.toggle('show', on);
      if (on) barText.textContent = st === 'starting' ? '准备中……' : '在听……再点一下结束';
    },
    onPartial: function (t) {
      input.value = t;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 116) + 'px';
      barText.textContent = t ? '在听：' + t.slice(-16) : '在听……';
    },
    onFinal: function (t) {
      input.value = t;
      bar.classList.remove('show');
      mic.classList.remove('rec');
      if (t) UI.toast('听到了。不满意可以改了再发。', 2200);
      else UI.toast('没听清。再说一次，或者直接打字也行。', 2600);
    },
    onError: function (e) {
      bar.classList.remove('show');
      mic.classList.remove('rec');
      UI.toast(e, 3000);
    }
  });

  // 点一下开始，再点一下结束 —— 不用一直按着，累的时候手指也不用使劲
  mic.onclick = function () {
    if (Voice.isListening()) Voice.stop();
    else {
      if (!Voice.asrAvailable()) { UI.toast('这台设备没有语音识别。打字也一样，我不着急。', 3200); return; }
      Voice.start();
    }
  };
}

/* ============================================================
 * 启动
 * ============================================================ */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

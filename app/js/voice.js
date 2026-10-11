/* ============================================================
 * voice.js — 语音（说给它听 / 让它念给你听）
 * ------------------------------------------------------------
 * 识别：安卓系统 SpeechRecognizer（免 Key、免联网费、中文由系统引擎提供）
 *       —— 通过原生桥，WebView 自己不支持这个。
 *       浏览器里退化为 Web Speech API（桌面调试用）。
 * 播报：安卓系统 TextToSpeech。同样走原生桥。
 *
 * 设计：说不出话的时候，按一下就行，不用打字。
 *      这是给"连打字都没力气"的时刻准备的。
 * ============================================================ */
'use strict';

let recognizing = false;
let handlers = { onPartial: null, onFinal: null, onError: null, onState: null };
let webRec = null;

function native() { return window.NuanyuNative || null; }

function asrAvailable() {
  if (native() && typeof native().startASR === 'function') {
    return native().asrAvailable ? !!native().asrAvailable() : true;
  }
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function ttsAvailable() {
  if (native() && typeof native().speak === 'function') {
    return native().ttsAvailable ? !!native().ttsAvailable() : true;
  }
  return typeof window.speechSynthesis !== 'undefined';
}

function setHandlers(h) { handlers = Object.assign(handlers, h || {}); }

/* ---------- 原生事件（由 __nuanyu._on 转发进来） ---------- */
function _onNativeEvent(m) {
  const t = m.type || '';
  if (t === 'asr_partial') { handlers.onPartial && handlers.onPartial(m.text || ''); return; }
  if (t === 'asr_final') {
    recognizing = false;
    handlers.onState && handlers.onState('idle');
    handlers.onFinal && handlers.onFinal(m.text || '');
    return;
  }
  if (t === 'asr_error') {
    recognizing = false;
    handlers.onState && handlers.onState('idle');
    handlers.onError && handlers.onError(m.text || '识别失败');
    return;
  }
  if (t === 'asr_ready') { handlers.onState && handlers.onState('listening'); return; }
  if (t === 'asr_end') {
    recognizing = false;
    handlers.onState && handlers.onState('idle');
    // 有些机型不给 final，只有 end：用最后一次 partial 兜底
    if (lastPartial) { handlers.onFinal && handlers.onFinal(lastPartial); lastPartial = ''; }
    return;
  }
}

let lastPartial = '';

/* ---------- 开始 / 停止 ---------- */
function start() {
  if (recognizing) return;
  handlers.onError && (lastPartial = '');
  const lang = (Store.load().profile.lang) || 'zh-CN';

  if (native() && typeof native().startASR === 'function') {
    recognizing = true;
    handlers.onState && handlers.onState('starting');
    try { native().startASR(lang); }
    catch (e) { recognizing = false; handlers.onError && handlers.onError('启动识别失败：' + e); }
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { handlers.onError && handlers.onError('这个设备没有可用的语音识别'); return; }

  webRec = new SR();
  webRec.lang = lang;
  webRec.continuous = false;
  webRec.interimResults = true;
  recognizing = true;
  handlers.onState && handlers.onState('listening');

  webRec.onresult = function (ev) {
    let interim = '', final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    if (interim) { lastPartial = interim; handlers.onPartial && handlers.onPartial(interim); }
    if (final) { lastPartial = ''; handlers.onPartial && handlers.onPartial(final); }
  };
  webRec.onerror = function (ev) {
    recognizing = false;
    handlers.onState && handlers.onState('idle');
    const map = {
      'not-allowed': '没有麦克风权限',
      'service-not-allowed': '这个设备没有语音识别服务',
      'no-speech': '没听到声音',
      'network': '识别服务连不上',
      'audio-capture': '找不到麦克风'
    };
    handlers.onError && handlers.onError(map[ev.error] || ('识别出错：' + ev.error));
  };
  webRec.onend = function () {
    recognizing = false;
    handlers.onState && handlers.onState('idle');
    if (lastPartial) { handlers.onFinal && handlers.onFinal(lastPartial); lastPartial = ''; }
  };
  try { webRec.start(); } catch (e) { recognizing = false; handlers.onError && handlers.onError('启动识别失败：' + e); }
}

function stop() {
  if (!recognizing) return;
  if (native() && typeof native().stopASR === 'function') { try { native().stopASR(); } catch (e) {} return; }
  if (webRec) { try { webRec.stop(); } catch (e) {} }
}

function isListening() { return recognizing; }

/* ---------- 播报 ---------- */
function speak(text) {
  const t = String(text || '').trim();
  if (!t) return;
  // 危机号码不要念成一串数字，替换成口语
  const clean = t.replace(/010-82951332/g, '零一零，八二九五，一三三二')
                 .replace(/12356/g, '一二三五六');
  const p = Store.load().profile;
  if (native() && typeof native().speak === 'function') {
    try { native().speak(clean, p.rate || 0.92, p.pitch || 1.0); } catch (e) {}
    return;
  }
  if (typeof window.speechSynthesis === 'undefined') return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = p.lang || 'zh-CN';
    u.rate = p.rate || 0.92;
    u.pitch = p.pitch || 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

function stopSpeaking() {
  if (native() && typeof native().stopSpeaking === 'function') { try { native().stopSpeaking(); } catch (e) {} return; }
  if (typeof window.speechSynthesis !== 'undefined') { try { window.speechSynthesis.cancel(); } catch (e) {} }
}

window.Voice = {
  asrAvailable, ttsAvailable, setHandlers, start, stop, isListening,
  speak, stopSpeaking, _onNativeEvent
};

/* ============================================================
 * ai.js — 两条通道，一个接口
 * ------------------------------------------------------------
 * 通道 A（安卓内）：window.NuanyuNative.chat(payload, reqId)
 *   走原生 HttpURLConnection 逐行读 SSE —— 绕开 WebView 的 CORS，
 *   并且真正做到逐字上屏。Key 不出手机。
 * 通道 B（浏览器内）：fetch + ReadableStream
 *   给桌面调试用（需要一个允许 CORS 的代理，见 _scripts/dev-proxy.js）。
 *
 * 没有 Key 时：走 Comfort 本地安慰模式，App 依然完整可用。
 * ============================================================ */
'use strict';

const listeners = new Map();   // reqId -> {onDelta,onDone,onError}
let seq = 0;

/* ---------- 原生事件入口（MainActivity 通过 evaluateJavascript 调用） ---------- */
window.__nuanyu = {
  _on(jsonStr) {
    let m;
    try { m = JSON.parse(jsonStr); } catch (e) { return; }
    const type = m.type || '';

    // 语音事件没有 id，必须先分流再走 listeners 守卫。
    // （踩过：放在守卫后面会被 `if (!h) return` 直接吞掉，
    //   现象是识别器明明启动了、界面却一个字都不出。）
    if (type.indexOf('asr_') === 0) {
      if (window.Voice && window.Voice._onNativeEvent) window.Voice._onNativeEvent(m);
      return;
    }

    const h = listeners.get(m.id);
    if (!h) return;
    if (type === 'delta') { h.onDelta && h.onDelta(m.text || ''); return; }
    if (type === 'done') { listeners.delete(m.id); h.onDone && h.onDone(m.text || '', m.meta || {}); return; }
    if (type === 'error') { listeners.delete(m.id); h.onError && h.onError(m.text || '未知错误'); return; }
  }
};

function hasNative() {
  return !!(window.NuanyuNative && typeof window.NuanyuNative.chat === 'function');
}

function hasKey() {
  const k = Store.load().ai.apiKey || '';
  return k.trim().length > 8;
}

function endpoint() {
  const ai = Store.load().ai;
  let base = (ai.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/+$/, '');
  // 允许用户填 .../v1 或裸域名
  return base + '/chat/completions';
}

function payloadFor(messages, opts) {
  const ai = Store.load().ai;
  const want = typeof (opts && opts.temperature) === 'number' ? opts.temperature : ai.temperature;
  return {
    url: endpoint(),
    apiKey: (ai.apiKey || '').trim(),
    model: ai.model || 'glm-4-flash',
    // 各家温度取值范围不同（智谱 [0,1)，DeepSeek [0,2]），
    // 不夹紧会被接口以"参数非法"直接拒掉：暖屿默认 1.3 发给智谱会报错。
    temperature: window.Providers ? Providers.clampTemperature(ai.providerId, want) : want,
    maxTokens: (opts && opts.maxTokens) || ai.maxTokens || 400,
    messages: messages
  };
}

/* ---------- SSE 解析（通道 B 用） ---------- */
function makeSSEParser(onDelta) {
  let buf = '';
  let full = '';
  return function feed(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        const piece = d && (d.content || '');
        if (piece) { full += piece; onDelta(piece); }
      } catch (e) { /* 半个 JSON，忽略 */ }
    }
    return full;
  };
}

/* ---------- 统一入口 ---------- */
/**
 * @param {Array<{role,content}>} messages
 * @param {{onDelta?:Function,onDone?:Function,onError?:Function}} handlers
 */
function stream(messages, handlers) {
  const h = {
    onDelta: (handlers && handlers.onDelta) || function () {},
    onDone: (handlers && handlers.onDone) || function () {},
    onError: (handlers && handlers.onError) || function () {}
  };
  const payload = payloadFor(messages, handlers);

  if (hasNative()) {
    const reqId = 'r' + (++seq) + '_' + Date.now();
    listeners.set(reqId, h);
    try {
      window.NuanyuNative.chat(JSON.stringify(payload), reqId);
    } catch (e) {
      listeners.delete(reqId);
      h.onError('无法调用原生网络：' + (e && e.message ? e.message : e));
    }
    return { abort: function () { try { window.NuanyuNative.abort(reqId); } catch (e) {} listeners.delete(reqId); } };
  }

  // 通道 B：浏览器
  const ctrl = new AbortController();
  (async function () {
    let full = '';
    try {
      const res = await fetch(payload.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + payload.apiKey
        },
        body: JSON.stringify({
          model: payload.model,
          messages: payload.messages,
          stream: true,
          temperature: payload.temperature,
          max_tokens: payload.maxTokens
        })
      });
      if (!res.ok) {
        const txt = await res.text().catch(function () { return ''; });
        h.onError('接口返回 ' + res.status + '：' + txt.slice(0, 200));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      const feed = makeSSEParser(function (piece) { h.onDelta(piece); });
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        full = feed(dec.decode(r.value, { stream: true })) || full;
      }
      h.onDone(full, { channel: 'fetch' });
    } catch (e) {
      if (e && e.name === 'AbortError') { h.onDone(full, { aborted: true }); return; }
      h.onError('网络失败：' + (e && e.message ? e.message : e));
    }
  })();

  return { abort: function () { try { ctrl.abort(); } catch (e) {} } };
}

/* ---------- 测试连接（设置页用） ---------- */
function testConnection() {
  return new Promise(function (resolve) {
    if (!hasKey()) { resolve({ ok: false, msg: '还没填 API Key' }); return; }
    let got = '';
    let settled = false;
    const finish = function (r) { if (!settled) { settled = true; resolve(r); } };
    stream(
      [{ role: 'user', content: '说一句很短的话。' }],
      {
        onDelta: function (t) { got += t; },
        onDone: function () { finish({ ok: true, msg: '连通了。' + (got ? '它回的是：' + got.slice(0, 40) : '') }); },
        onError: function (e) { finish({ ok: false, msg: e }); }
      }
    );
    setTimeout(function () { finish(got ? { ok: true, msg: '有回应：' + got.slice(0, 40) } : { ok: false, msg: '超时了，检查网络或 Key' }); }, 20000);
  });
}

window.AI = { stream, hasKey, hasNative, testConnection, endpoint };

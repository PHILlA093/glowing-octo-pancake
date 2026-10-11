/* ============================================================
 * cdp.js — 在模拟器/真机的 WebView 里执行 JS、抓日志、截图
 * ------------------------------------------------------------
 * 为什么不只看截图：截图看不出 JS 报错、看不出状态对不对。
 * 前人红线原文：「'API 全绿 ≠ 能玩'：凡是'能拼出来 / 能点开 /
 * 能触发'的断言，必须用真点击或真指针事件驱动，只走 API 的
 * 绿灯是假的。」
 * 所以这个工具用 Input.dispatchMouseEvent 做真点击，不用 .click()。
 *
 * 用法:
 *   node _scripts/cdp.js eval "<js 表达式>"
 *   node _scripts/cdp.js shot  <输出png>
 *   node _scripts/cdp.js tap   <x> <y>
 *   node _scripts/cdp.js logs             (抓 console 报错)
 *   node _scripts/cdp.js wait  <毫秒>
 * ============================================================ */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ADB = 'E:\\android\\sdk\\platform-tools\\adb.exe';
const PORT = 9222;

function adb(args) {
  const r = spawnSync(ADB, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function discover() {
  // 1) 找 WebView 的 devtools socket
  let r = adb(['shell', 'cat', '/proc/net/unix']);
  if (r.code !== 0) throw new Error('adb shell 失败: ' + r.out);
  const sockets = (r.out.match(/@?webview_devtools_remote[_0-9]*/g) || []);
  if (!sockets.length) throw new Error('没找到 WebView 调试 socket —— App 是不是还没启动？');
  const sock = sockets[sockets.length - 1].replace(/^@/, '');

  // 2) 转发到本机
  adb(['forward', '--remove', 'tcp:' + PORT]);
  r = adb(['forward', 'tcp:' + PORT, 'localabstract:' + sock]);
  if (r.code !== 0) throw new Error('adb forward 失败: ' + r.out);

  // 3) 拿 webSocketDebuggerUrl
  const http = require('http');
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json', timeout: 8000 }, function (res) {
      let body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () {
        let pages;
        try { pages = JSON.parse(body); } catch (e) { return reject(new Error('解析 /json 失败: ' + body.slice(0, 200))); }
        if (!pages.length) return reject(new Error('没有可调试的页面'));
        // 挑应用页面（capacitor 的地址是 https://localhost）
        const app = pages.find(p => /localhost|nuanyu|index\.html/i.test(p.url || '')) || pages[0];
        resolve({ wsUrl: app.webSocketDebuggerUrl, url: app.url, pages: pages });
      });
    }).on('error', reject).on('timeout', function () { reject(new Error('/json 超时')); });
  });
}

function connect(wsUrl) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(wsUrl);
    const waiters = new Map();
    const events = [];
    let seq = 0;
    // 连接本身也要有超时，否则 WS 卡住会把整个脚本挂死（踩过）
    const openTimer = setTimeout(function () { reject(new Error('WebSocket 连接超时: ' + wsUrl)); }, 10000);
    ws.onopen = function () {
      clearTimeout(openTimer);
      resolve({
        events: events,
        send: function (method, params) {
          const id = ++seq;
          return new Promise(function (res, rej) {
            waiters.set(id, { res: res, rej: rej });
            ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
            setTimeout(function () {
              if (waiters.has(id)) { waiters.delete(id); rej(new Error(method + ' 超时')); }
            }, 25000);
          });
        },
        close: function () { try { ws.close(); } catch (e) {} }
      });
    };
    ws.onmessage = function (ev) {
      const m = JSON.parse(ev.data);
      if (m.id && waiters.has(m.id)) {
        const w = waiters.get(m.id); waiters.delete(m.id);
        if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    };
    ws.onerror = function (e) { reject(new Error('WS 错误: ' + (e && e.message))); };
  });
}

async function main() {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  if (!cmd) { console.log(fs.readFileSync(__filename, 'utf8').split('===')[0]); process.exit(1); }

  const d = await discover();
  const c = await connect(d.wsUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');

  if (cmd === 'eval') {
    const exprFile = process.argv[4];
    const expr = exprFile && fs.existsSync(exprFile) ? fs.readFileSync(exprFile, 'utf8') : arg;
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails, null, 1)); process.exitCode = 2; }
    else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));

  } else if (cmd === 'tap') {
    // 真指针事件，不用 .click()（前人红线：只走 API 的绿灯是假的）
    // 必须带 buttons 字段，否则 WebView 偶发不派发 click
    const x = Number(arg), y = Number(process.argv[4]);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, buttons: 0 });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 70));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 });
    console.log('tap ' + x + ',' + y);

  } else if (cmd === 'text') {
    // 真实输入（要先把光标点进输入框），不是直接改 .value
    await c.send('Input.insertText', { text: arg });
    console.log('typed: ' + arg);

  } else if (cmd === 'tapsel') {
    // 按选择器点击：先查实时坐标再派发，避免软键盘把布局顶起来后坐标漂移
    // 按选择器点击：先查实时坐标再派发，避免软键盘把布局顶起来后坐标漂移。
    // 刻意不调用 scrollIntoView —— 它会滚动带 overflow 的祖先
    // （包括 overflow:hidden 的 #app，hidden 仍允许程序化滚动），
    // 把整个应用滚偏，后续按坐标的点击全部落空。
    const r = await c.send('Runtime.evaluate', {
      expression: "(function(){var e=document.querySelector(" + JSON.stringify(arg) + ");"
        + "if(!e) return null;"
        + "var b=e.getBoundingClientRect();"
        + "return JSON.stringify({x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:Math.round(b.width), h:Math.round(b.height)});})()",
      returnByValue: true
    });
    if (!r.result.value) { console.error('找不到元素: ' + arg); process.exit(1); }
    const box = JSON.parse(r.result.value);
    if (box.w === 0 || box.h === 0) { console.error('元素不可见: ' + arg); process.exit(1); }

    // 诚实检查：坐标算出来了不等于点得到。若被别的元素盖住（浮层遮罩、
    // 键盘顶起的窗口、上层弹窗），这里必须报错而不是假装点成功了。
    const chk = await c.send('Runtime.evaluate', {
      expression: "(function(){var e=document.querySelector(" + JSON.stringify(arg) + ");"
        + "var b=e.getBoundingClientRect();"
        + "var t=document.elementFromPoint(Math.round(b.x+b.width/2),Math.round(b.y+b.height/2));"
        + "if(!t) return 'NONE';"
        + "if(t===e||e.contains(t)) return 'OK';"
        + "return 'BLOCKED:'+t.tagName+(t.id?'#'+t.id:'')+(t.className?'.'+String(t.className).split(' ').join('.'):'');})()",
      returnByValue: true
    });
    const verdict = chk.result.value;
    if (verdict !== 'OK') {
      console.error('点不到 ' + arg + ' —— 被挡住了: ' + verdict + '（坐标 ' + box.x + ',' + box.y + '）');
      process.exit(3);
    }

    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise(r2 => setTimeout(r2, 70));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
    console.log('tapsel ' + arg + ' @ ' + box.x + ',' + box.y);

  } else if (cmd === 'shot') {
    const out = arg || path.join(os.tmpdir(), 'ny-shot.png');
    // 走 adb 截图（能拍到状态栏/导航栏，更接近用户看到的）
    const r1 = adb(['shell', 'screencap', '-p', '/sdcard/__ny.png']);
    const r2 = adb(['pull', '/sdcard/__ny.png', out]);
    adb(['shell', 'rm', '-f', '/sdcard/__ny.png']);
    if (!fs.existsSync(out)) { console.error('截图失败: ' + r1.out + r2.out); process.exit(1); }
    console.log(out + '  ' + fs.statSync(out).size + ' B');

  } else if (cmd === 'logs') {
    await new Promise(r => setTimeout(r, Number(arg) || 1200));
    const bad = c.events.filter(e =>
      (e.method === 'Log.entryAdded' && /error|warning/i.test(e.params.entry.level)) ||
      e.method === 'Runtime.exceptionThrown');
    if (!bad.length) { console.log('控制台干净：没有 error / exception'); }
    else bad.forEach(function (e) {
      if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION: ' + JSON.stringify(e.params.exceptionDetails.text || e.params.exceptionDetails));
      else console.log('[' + e.params.entry.level + '] ' + e.params.entry.text);
    });

  } else if (cmd === 'wait') {
    await new Promise(r => setTimeout(r, Number(arg) || 1000));
    console.log('waited ' + (Number(arg) || 1000) + 'ms');

  } else {
    console.error('未知命令: ' + cmd);
    process.exitCode = 1;
  }
  c.close();
}

main().catch(function (e) { console.error('ERROR: ' + e.message); process.exit(1); });

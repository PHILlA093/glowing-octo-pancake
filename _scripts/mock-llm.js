/* ============================================================
 * mock-llm.js — 本地假模型，用来验证原生流式通道
 * ------------------------------------------------------------
 * 为什么不直接用真 Key 测：
 *   1) 不该为了测试去翻用户的 Key，更不该把它写进任何文件；
 *   2) 真接口无法制造"逐字到达"的确定性时序，测不出流式是否真的流式。
 *
 * 它按 OpenAI/DeepSeek 的 SSE 格式逐块吐字，故意带：
 *   · 非 200 分支（用 /chat/completions?fail=401 触发）
 *   · 空 delta、注释行、[DONE]
 * 用来验证 MainActivity 的 SSE 解析、60ms 合批、错误翻译。
 *
 * 安卓模拟器访问宿主机用 10.0.2.2。
 * 用法: node _scripts/mock-llm.js [端口]
 * ============================================================ */
'use strict';
const http = require('http');

const PORT = Number(process.argv[2]) || 8899;

const REPLY = '嗯。我在。\n不用解释什么，就这样待着也行。';

http.createServer(function (req, res) {
  // 故障注入：验证 App 会不会把 4xx 原样糊到用户脸上
  // baseUrl 设成 .../fail401 即可触发（endpoint() 会拼成 /fail401/chat/completions）
  if (req.url.includes('fail401')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Authentication Fails","type":"authentication_error"}}');
    return;
  }

  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) {}
    console.log('[mock] 收到请求 model=' + parsed.model
      + ' stream=' + parsed.stream
      + ' 授权头=' + (req.headers.authorization ? '有' : '无')
      + ' 消息数=' + ((parsed.messages || []).length)
      + ' 温度=' + parsed.temperature);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // SSE 注释行 + 空 delta，确认解析器能跳过
    res.write(': keep-alive\n\n');
    res.write('data: {"choices":[{"delta":{}}]}\n\n');

    const chars = Array.from(REPLY);
    let i = 0;
    const timer = setInterval(function () {
      if (i >= chars.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        console.log('[mock] 发完 ' + chars.length + ' 个字符');
        return;
      }
      const piece = JSON.stringify({ choices: [{ delta: { content: chars[i] } }] });
      res.write('data: ' + piece + '\n\n');
      i++;
    }, 35);   // 每个字 35ms，肉眼能看出是逐字上屏
  });
}).listen(PORT, '0.0.0.0', function () {
  console.log('假模型已启动: http://0.0.0.0:' + PORT + '/chat/completions');
  console.log('模拟器内请填: http://10.0.2.2:' + PORT);
});

/* ============================================================
 * sync-www.js — 把 app\ (Web 源码) 同步进 Capacitor 的 www\ (产物)
 * ------------------------------------------------------------
 * 纪律（沿用本机 2026-10-02 实测踩坑记录）:
 *   · www\ 是产物不是源码 —— 改页面请改 app\,不要改 www\
 *   · 先清空 www\ 再整目录复制,并同步清空 android\assets\public\
 *     (cap sync 只增不删,不清会残留上一版文件)
 *   · 排除: 下划线/_* 开头、.* 开头、*.bak*、*.md、*.log、*.tmp、旧 APK
 *   · 同步后打印文件数,文件数是判断排除规则是否失效的唯一判据
 *
 * 用法: node _scripts/sync-www.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app');
const DST = path.join(ROOT, 'www');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.vscode', '_shots', '_work']);

/**
 * 名字级"临时文件"判据。目录也走同一套规则。
 * 踩过的坑: xxx.txt.bak-五科前-20260922 的扩展名不是 .bak,
 * 用 path.extname 匹配不到 → 46MB 备份被打进 APK。
 */
function isTempFile(name) {
  if (name.charAt(0) === '_') return true;
  if (name.charAt(0) === '.') return true;
  if (/\.bak($|[-_.])/i.test(name)) return true;
  return false;
}

const EXCLUDE_FILE_EXT = new Set(['.md', '.log', '.tmp', '.bak', '.apk', '.zip', '.ps1']);

let copied = 0, bytes = 0;
const skipped = [];
const manifest = [];

function walk(rel) {
  const abs = path.join(SRC, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (isTempFile(e.name) || EXCLUDE_DIRS.has(e.name)) {
      skipped.push(childRel + (e.isDirectory() ? '\\' : ''));
      continue;
    }
    if (e.isDirectory()) {
      fs.mkdirSync(path.join(DST, childRel), { recursive: true });
      walk(childRel);
      continue;
    }
    if (!e.isFile()) continue;
    if (EXCLUDE_FILE_EXT.has(path.extname(e.name).toLowerCase())) { skipped.push(childRel); continue; }
    const to = path.join(DST, childRel);
    fs.copyFileSync(path.join(SRC, childRel), to);
    copied++;
    const size = fs.statSync(to).size;
    bytes += size;
    manifest.push(childRel.replace(/\\/g, '/') + '  ' + size + ' B');
  }
}

// 1) 清空 www
if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
// 2) 复制
walk('');

// 3) 顺手清空 android 侧 assets/public（cap sync 只覆盖/新增,不删除）
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
let cleaned = 0;
if (fs.existsSync(ASSETS)) {
  cleaned = fs.readdirSync(ASSETS).length;
  fs.rmSync(ASSETS, { recursive: true, force: true });
}

// 4) 关键文件必须存在,否则页面会白屏(进包前拦一道)
const REQUIRED = ['index.html', 'css/app.css', 'js/app.js'];
const missing = REQUIRED.filter(f => !fs.existsSync(path.join(DST, f)));
if (missing.length) {
  console.error('同步失败: 缺少必需文件 -> ' + missing.join(', '));
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, '_www-manifest.txt'),
  'www 清单 @ ' + new Date().toISOString() + '\n文件数 ' + copied + '\n' + manifest.sort().join('\n') + '\n');

console.log('www 同步完成: ' + copied + ' 个文件 / ' + (bytes / 1024).toFixed(1) + ' KB');
if (cleaned) console.log('已清空 assets/public (' + cleaned + ' 项),cap sync 会按 www 重建');
console.log('排除 ' + skipped.length + ' 项' + (skipped.length ? ': ' + skipped.slice(0, 10).join(' , ') + (skipped.length > 10 ? ' …' : '') : ''));

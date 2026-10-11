/* ============================================================
 * build-apk.js — 一条命令走完打包三步
 * ------------------------------------------------------------
 *   ① node _scripts/sync-www.js      app\ → www\（先清空再复制）
 *   ② npx cap sync android           www\ → android\assets\public\
 *   ③ gradlew assembleDebug          出 APK
 *
 * 本机三个环境变量每次新会话都是空的，必须在这里显式设置，
 * 不能依赖系统环境（这是前人踩过的坑，见 打包说明.md）。
 *
 * 用法: node _scripts/build-apk.js
 * ============================================================ */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const APK = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

const ENV = Object.assign({}, process.env, {
  JAVA_HOME: 'E:\\android\\jdk17',
  ANDROID_HOME: 'E:\\android\\sdk',
  ANDROID_SDK_ROOT: 'E:\\android\\sdk',
  GRADLE_USER_HOME: 'E:\\android\\gradle-home'
});

function step(n, title) { console.log('\n=== [' + n + '/3] ' + title + ' ==='); }

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd: cwd || ROOT, env: ENV, stdio: 'inherit', shell: false });
  if (r.error) { console.error('启动失败: ' + cmd + ' -> ' + r.error.message); process.exit(1); }
  if (r.status !== 0) { console.error('\n失败（退出码 ' + r.status + '），已停在: ' + cmd + ' ' + args.join(' ')); process.exit(r.status || 1); }
}

/* 前置检查：工具链在位，否则给一句人话而不是一堆 Java 堆栈 */
for (const p of ['E:\\android\\jdk17\\bin\\java.exe', 'E:\\android\\sdk\\platform-tools\\adb.exe']) {
  if (!fs.existsSync(p)) { console.error('找不到 ' + p + '，安卓工具链不在预期位置。'); process.exit(1); }
}

step(1, '同步 app\\ → www\\');
run(process.execPath, [path.join(__dirname, 'sync-www.js')]);

step(2, 'cap sync android');
run(process.execPath, [path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android']);

step(3, 'gradlew assembleDebug');
// 注意：Node 20+ 禁止用 spawnSync 直接执行 .bat/.cmd（会报 EINVAL），
// 必须经 cmd.exe /c 转一手。
const gradlew = path.join(ANDROID_DIR, 'gradlew.bat');
run('cmd.exe', ['/c', gradlew, 'assembleDebug', '--no-daemon', '--console=plain'], ANDROID_DIR);

if (!fs.existsSync(APK)) { console.error('\n没找到 APK: ' + APK); process.exit(1); }
const mb = (fs.statSync(APK).size / 1048576).toFixed(2);
console.log('\n出包成功: ' + APK + '  (' + mb + ' MB)');

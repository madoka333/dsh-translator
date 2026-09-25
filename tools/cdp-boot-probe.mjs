// tools/cdp-boot-probe.mjs — 启动判决：DSH 的 Web boot 会不会被本插件拖死？
//
// dsh 的客户端启动逻辑会遍历**每一个 loader entry**，只要有一个不是 active 就抛
//   web boot: N entries did not activate
// 而 "pending (waiting for service: X)" 也算 not active。于是"某个插件声明了一个
// 新版 dsh 已经改名的服务"这件事，代价是**整个 Web UI 停在开机画面**。
//
// 本插件因此把全部服务声明挪进了 ctx.inject 子 fiber。这个脚本用来实测那条推理：
// 子 fiber 停在 pending 时，页面到底还起不起得来。
//
// 用法（先在 9222 上起好带 token 的 headless Chrome）：
//   node tools/cdp-boot-probe.mjs
// 环境变量：CDP_HTTP（默认 http://127.0.0.1:9222）、EXPECT（tab / parked）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const EXPECT = process.env.EXPECT || 'tab';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
mkdirSync(OUT, { recursive: true });

const list = await (await fetch(CDP_HTTP + '/json/list')).json();
const target = list.find((t) => t.type === 'page' && /3080/.test(t.url));
if (!target) { console.error('no dsh page target'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let nextId = 1;
const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    exceptions.push((d.text || '') + ' :: ' + (d.exception?.description || ''));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
});
const run = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  try { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64')); }
  catch { /* screenshot is evidence, not the verdict */ }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });

let verdict = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  verdict = await run(`(() => {
    const text = (document.body?.innerText || '').slice(0, 400);
    const bootScreen = /Failed to load plugins|did not activate|Loading plugins/.test(text);
    const composer = document.querySelector('textarea, [contenteditable="true"], [data-composer], input[type="text"]');
    const appRoot = document.querySelector('#root');
    return {
      bootScreen,
      appMounted: appRoot !== null && (appRoot.childElementCount || 0) > 0 && !bootScreen,
      composer: composer !== null,
      translatorUi: document.querySelectorAll('[data-dsh-translator-ui]').length,
      styleTag: document.getElementById('dsh-translator-style') !== null,
      guideTranslator: document.querySelector('[data-sidebar-right-guide-entry="translator"]') !== null,
      bodyHead: text.slice(0, 160),
    };
  })()`);
  if (verdict && (verdict.bootScreen || verdict.composer)) break;
}
await shot('g-boot-probe.png');

console.log('boot probe:', JSON.stringify(verdict));
console.log('exceptions:', exceptions.length === 0 ? '(none)' : exceptions.slice(0, 2).join(' | ').slice(0, 400));

const ok =
  verdict &&
  verdict.appMounted === true &&
  verdict.composer === true &&
  !verdict.bootScreen &&
  (EXPECT === 'tab' ? verdict.guideTranslator === true || verdict.translatorUi > 0 : verdict.translatorUi >= 0);
console.log(ok ? `BOOT PROBE PASSED (expect=${EXPECT})` : `BOOT PROBE FAILED (expect=${EXPECT})`);
process.exit(ok ? 0 : 1);

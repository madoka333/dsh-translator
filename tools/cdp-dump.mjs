// tools/cdp-dump.mjs
// 一次性取证脚本：连上已经跑着的无头 Chrome（--remote-debugging-port=9222），
// 在真页面里执行诊断，把 console / 异常 / DOM 事实 / 截图落到 .evidence/ 下。
// 只读：不改动 dsh web、不改动插件产物。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
const WAIT_MS = Number(process.env.CDP_WAIT_MS || 12000);

mkdirSync(OUT, { recursive: true });

const list = await (await fetch(CDP_HTTP + '/json/list')).json();
const pages = list.filter((t) => t.type === 'page' && /127\.0\.0\.1:3080|localhost:3080/.test(t.url));
if (!pages.length) {
  console.error('no dsh page target found. targets:', list.map((t) => `${t.type} ${t.url}`).join('\n  '));
  process.exit(2);
}
const target = pages[0];
console.log('target:', target.title, target.url);
console.log('ws:', target.webSocketDebuggerUrl);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('ws connect failed'));
});

let nextId = 1;
const pending = new Map();
const consoleLines = [];
const exceptions = [];

ws.onmessage = (ev) => {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.method + ' ' + JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => {
        if (a.type === 'string') return a.value;
        if ('value' in a) return safeJson(a.value);
        return a.description || a.type;
      })
      .join(' ');
    consoleLines.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    const desc = d.exception?.description || d.text || '';
    exceptions.push(`${d.text || ''} :: ${desc}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry || {};
    consoleLines.push(`[log:${e.level}] ${e.text}${e.url ? ' @ ' + e.url : ''}`);
  }
};

function safeJson(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 30000);
  });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

console.log(`waiting ${WAIT_MS}ms for app to settle...`);
await new Promise((r) => setTimeout(r, WAIT_MS));

const PROBE = String.raw`
(() => {
  const out = {};
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  out.href = location.href;
  out.title = document.title;
  out.readyState = document.readyState;
  out.bodyChildCount = document.body ? document.body.children.length : -1;
  out.bodyClass = document.body ? document.body.className : null;

  // 宿主探针面板
  const hostProbe = q('[data-dsht-host-probe]') || q('#dsh-translator-host-probe') ||
    qa('div').find((d) => /dsh-translator 宿主探针/.test(d.textContent || ''));
  out.hostProbeFound = !!hostProbe;
  out.hostProbeText = hostProbe ? (hostProbe.innerText || hostProbe.textContent || '').slice(0, 4000) : null;

  // 客户端自检面板
  const clientProbe = qa('div').find((d) => /dsh-translator 自检/.test(d.textContent || ''));
  out.clientProbeFound = !!clientProbe;
  out.clientProbeText = clientProbe ? (clientProbe.innerText || clientProbe.textContent || '').slice(0, 4000) : null;

  // 座位错误 / 无查看方式
  out.slotErrorCells = qa('[data-slot-error]').map((e) => e.getAttribute('data-slot-error'));
  out.unavailable = qa('[data-sidebar-right-unavailable]').map((e) => (e.textContent || '').slice(0, 200));
  out.paneInDom = qa('.dsht-pane').length;
  out.translatorUiNodes = qa('[data-dsh-translator-ui]').length;

  // 所有 data-* 属性名（去重）+ 出现次数，用来发现真实的插槽/侧栏契约
  const tally = {};
  for (const el of qa('*')) {
    for (const a of el.attributes || []) {
      if (a.name.startsWith('data-') || a.name.startsWith('aria-')) {
        tally[a.name] = (tally[a.name] || 0) + 1;
      }
    }
  }
  out.attrTally = tally;

  // 右侧栏相关的元素（含祖先），输出一段有界的 HTML
  const rightish = qa('[data-sidebar-], [class*=sidebar], [class*=Sidebar], aside').slice(0, 12);
  out.rightishSamples = rightish.map((e) => ({
    tag: e.tagName,
    cls: (e.className || '').toString().slice(0, 200),
    attrs: Array.from(e.attributes).map((a) => a.name + '=' + String(a.value).slice(0, 80)),
    textLen: (e.textContent || '').length,
    textHead: (e.textContent || '').replace(/\s+/g, ' ').slice(0, 300),
    childCount: e.children.length,
  }));

  // 模块加载器里有没有我们的模块
  try {
    const ml = window.__ModuleLoader__;
    out.moduleLoader = ml ? Object.keys(ml).slice(0, 40) : null;
    if (ml && typeof ml.get === 'function') {
      out.mod = 'has get';
    }
    if (ml && ml.modules) out.moduleKeys = Object.keys(ml.modules).filter((k) => /translator/i.test(k));
    if (ml && ml.registry) out.registryKeys = Object.keys(ml.registry).filter((k) => /translator/i.test(k));
  } catch (e) {
    out.moduleLoaderErr = String(e);
  }
  try {
    out.scriptSrcs = qa('script[src]').map((s) => s.getAttribute('src')).slice(0, 60);
    out.linkHrefs = qa('link[href]').map((s) => s.getAttribute('href')).slice(0, 60);
  } catch (e) {
    out.assetErr = String(e);
  }

  out.dshtGlobals = Object.keys(window).filter((k) => /dsht|dsh/i.test(k)).slice(0, 80);

  out.bodyHtmlHead = document.body ? document.body.innerHTML.slice(0, 20000) : null;
  return out;
})()
`;

let evalRes;
try {
  evalRes = await send('Runtime.evaluate', {
    expression: PROBE,
    returnByValue: true,
    awaitPromise: false,
  });
} catch (e) {
  console.error('evaluate failed:', e.message);
}

const value = evalRes?.result?.value ?? null;
const thrown = evalRes?.exceptionDetails ?? null;

// 再抓一次：跟渲染相关的 React 线索（__reactFiber / 报错边界）
const REACT_PROBE = String.raw`
(() => {
  const out = {};
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('rej: ' + (e.reason && e.reason.message)));
  // React 根
  const root = document.getElementById('root') || document.body.firstElementChild;
  out.hasRoot = !!root;
  if (root) {
    out.rootKeys = Object.keys(root).filter((k) => k.startsWith('__react')).slice(0, 10);
    out.rootChildCount = root.children.length;
    out.rootHtmlHead = root.innerHTML.slice(0, 6000);
  }
  out.errs = errs;
  return out;
})()
`;
let reactRes = null;
try {
  reactRes = await send('Runtime.evaluate', { expression: REACT_PROBE, returnByValue: true });
} catch (e) {
  console.error('react probe failed:', e.message);
}

// 截图
let shotOk = false;
try {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, 'screen.png'), Buffer.from(shot.data, 'base64'));
  shotOk = true;
} catch (e) {
  console.error('screenshot failed:', e.message);
}

writeFileSync(
  join(OUT, 'report.json'),
  JSON.stringify(
    { target: { title: target.title, url: target.url }, value, thrown, react: reactRes?.result?.value ?? null, exceptions, consoleLines },
    null,
    2
  ),
  'utf8'
);
writeFileSync(join(OUT, 'console.txt'), consoleLines.join('\n'), 'utf8');
writeFileSync(join(OUT, 'exceptions.txt'), exceptions.join('\n'), 'utf8');

console.log('--- exceptions ---');
console.log(exceptions.join('\n') || '(none)');
console.log('--- console (tail 40) ---');
console.log(consoleLines.slice(-40).join('\n') || '(none)');
console.log('screenshot:', shotOk ? join(OUT, 'screen.png') : 'FAILED');
console.log('report:', join(OUT, 'report.json'));
ws.close();
process.exit(0);

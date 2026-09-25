// tools/cdp-pane-shot.mjs — 「只看面板」：导航到「翻译」页签并截图，用于 UI 迭代。
//
// 比整套 cdp-composer-flow 快得多（不提交翻译、不等模型）：它复用同一套导航步骤，
// 把 localStorage 里现存的引用渲染出来就截图。
//
// 用法（先在 9222 上起好带 token 的 headless Chrome）：
//   node tools/cdp-pane-shot.mjs                 # 用现存的引用/草稿
//   node tools/cdp-pane-shot.mjs --clear         # 先清掉本插件的 localStorage 再看空态
//   node tools/cdp-pane-shot.mjs --draft "text"  # 先塞一段草稿再看输入框
// 环境变量：NAME（截图文件名，默认 ui-pane.png）、CDP_HTTP、EVIDENCE_DIR。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
const NAME = process.env.NAME || (argv.includes('--clear') ? 'ui-empty.png' : 'ui-pane.png');
const DRAFT = argv.includes('--draft') ? argv[argv.indexOf('--draft') + 1] : undefined;
mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(CDP_HTTP + '/json/list')).json();
const target = targets.find((t) => t.type === 'page' && /3080/.test(t.url));
if (!target) { console.error('no dsh page target'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickAt = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  }
};
const centerOf = async (sel) => run(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.width > 0 && r.height > 0 };
})()`);

await send('Runtime.enable');
await send('Page.enable');

if (argv.includes('--clear') || DRAFT !== undefined) {
  await run(`(() => {
    const dead = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dsh-translator:')) dead.push(k);
    }
    dead.forEach((k) => localStorage.removeItem(k));
    return dead.length;
  })()`);
}
await send('Page.reload', { ignoreCache: true });

for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const r = await run(`(() => ({
    hasSidebar: !!document.querySelector('[data-slot="sidebar.workspaces"]'),
    titles: Array.from(document.querySelectorAll('[class*="YDXeBa_title"]')).length,
  }))()`);
  if (r?.hasSidebar && r.titles > 0) break;
}
await sleep(1500);
const entry = await centerOf('[data-slot="sidebar.workspaces"] [class*="YDXeBa_title"]');
if (entry?.visible) { await clickAt(entry.x, entry.y); await sleep(7000); }

const tg = await centerOf('[data-sidebar-right-toggle]');
if (tg?.visible) { await clickAt(tg.x, tg.y); await sleep(2000); }
if ((await run(`document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed')`)) === 'true') {
  await run(`document.querySelector('[data-sidebar-right-toggle]')?.click()`);
  await sleep(2500);
}
const g = await centerOf('[data-sidebar-right-guide-entry="translator"]');
if (g?.visible) await clickAt(g.x, g.y);
else await run(`document.querySelector('[data-sidebar-right-guide-entry="translator"]')?.click()`);
await sleep(3000);

// The draft has to be seeded AFTER the pane mounted: its composer reads the draft at
// mount, and a reload would have cleared a value written before it.
if (DRAFT !== undefined) {
  const sessionKey = await run(`(() => {
    const raw = Object.keys(localStorage).filter((k) => k.startsWith('dsh-translator:'));
    return raw.length > 0 ? raw[0].replace(/^dsh-translator:[a-z]+:/, '') : 'default';
  })()`);
  await run(`(() => {
    const area = document.querySelector('.dsht-input');
    if (!area) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, ${JSON.stringify(DRAFT)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  void sessionKey;
}

const facts = await run(`(() => {
  const pane = document.querySelector('.dsht-pane');
  if (!pane) return { pane: false };
  const kids = Array.from(pane.children);
  const box = document.querySelector('.dsht-composer');
  const btn = document.querySelector('.dsht-send');
  const pr = pane.getBoundingClientRect();
  const br = box ? box.getBoundingClientRect() : null;
  return {
    pane: true,
    cards: pane.querySelectorAll('.dsht-card').length,
    empty: !!pane.querySelector('.dsht-empty'),
    lastChildIsComposer: kids[kids.length - 1] === box,
    composerGap: br ? Math.round(pr.bottom - br.bottom) : null,
    sendVisible: (() => {
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const s = getComputedStyle(btn);
      return { w: Math.round(r.width), h: Math.round(r.height), opacity: s.opacity, inViewport: r.right <= window.innerWidth && r.bottom <= window.innerHeight };
    })(),
    modelText: (() => { const m = pane.querySelector('.dsht-card .dsht-meta'); return m ? (m.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null; })(),
    paneText: (pane.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
  };
})()`);
console.log('pane facts:', JSON.stringify(facts));

const s = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, NAME), Buffer.from(s.data, 'base64'));
console.log('shot ->', NAME);
ws.close();

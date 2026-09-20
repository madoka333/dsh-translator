// tools/cdp-full-flow.mjs — 一次跑完整条链路：
//   1) 无刷新回到 / 并重载      2) 打开真实会话
//   3) 展开右侧栏                4) 点「翻译」页签
//   5) 注入一段 markdown 英文    6) 划选它
//   7) 点浮动「译」              8) 等待 SSE 译文落到面板
//   9) 截图 + 取证               10) 清理注入节点
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
mkdirSync(OUT, { recursive: true });

const list = await (await fetch(CDP_HTTP + '/json/list')).json();
const target = list.find((t) => t.type === 'page' && /3080/.test(t.url));
if (!target) { console.error('no dsh page target'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let nextId = 1;
const pending = new Map();
const consoleLines = [];
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push('[' + msg.params.type + '] ' + (msg.params.args || []).map((a) => (a.type === 'string' ? a.value : a.value !== undefined ? safe(a.value) : a.description || a.type)).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    exceptions.push((d.text || '') + ' :: ' + (d.exception?.description || ''));
  }
};
function safe(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } }
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
  try { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64')); console.log('shot ->', name); }
  catch (e) { console.error('shot failed', e.message); }
};
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

const stage = [];
const note = (k, v) => { stage.push({ stage: k, ...(typeof v === 'object' && v !== null ? v : { value: v }) }); console.log(`[${k}]`, JSON.stringify(v)); };

await send('Runtime.enable');
await send('Page.enable');

// 1) 重载页面（客户端产物只在页面加载时抓一次），再等应用就绪
await send('Page.reload', { ignoreCache: true });
let ready = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  ready = await run(`(() => ({
    href: location.href,
    authWall: /authentication required/i.test(document.body?.innerText || ''),
    hasSidebar: !!document.querySelector('[data-slot="sidebar.workspaces"]'),
    sessionTitles: Array.from(document.querySelectorAll('[class*="YDXeBa_title"]')).map(e => (e.innerText||'').trim().slice(0,30)),
  }))()`);
  if (ready && ready.hasSidebar && (ready.sessionTitles || []).length > 0) { console.log(`app ready after ${i + 1}s`); break; }
  if (i % 5 === 4) console.log(`  waiting... t=${i + 1}s authWall=${ready?.authWall} hasSidebar=${ready?.hasSidebar} titles=${(ready?.sessionTitles || []).length}`);
}
note('01-page-ready', ready);
await shot('f0-ready.png');
if (ready?.sessionTitles?.length) { await sleep(2000); }

// 2) 打开真实会话
const entry = await centerOf('[data-slot="sidebar.workspaces"] [class*="YDXeBa_title"]');
note('02-session-entry', entry);
if (entry?.visible) { await clickAt(entry.x, entry.y); await sleep(8000); }
note('03-session-open', await run(`(() => ({
  conversationTextLen: (document.querySelector('[data-slot="conversation.session"]')?.textContent || '').length,
  rightbarCollapsed: document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null,
}))()`));
await shot('f1-session.png');

// 3) 展开右侧栏（真实点击；收起态下程序化点击兜底）
const tg = await centerOf('[data-sidebar-right-toggle]');
if (tg?.visible) { await clickAt(tg.x, tg.y); await sleep(2000); }
let rb = await run(`document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null`);
if (rb === 'true') { await run(`document.querySelector('[data-sidebar-right-toggle]')?.click()`); await sleep(2500); }
note('04-rightbar', await run(`(() => ({
  collapsed: document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null,
  guideEntries: Array.from(document.querySelectorAll('[data-sidebar-right-guide-entry]')).map(e => e.getAttribute('data-sidebar-right-guide-entry')),
}))()`));

// 4) 点「翻译」页签
const g = await centerOf('[data-sidebar-right-guide-entry="translator"]');
if (g?.visible) { await clickAt(g.x, g.y); } else { await run(`document.querySelector('[data-sidebar-right-guide-entry="translator"]')?.click()`); }
await sleep(3000);
note('05-pane', await run(`(() => {
  const p = document.querySelector('.dsht-pane');
  return {
    panePresent: !!p,
    stripTabs: (document.querySelector('[data-dockkit-strip-tabs]')?.innerText || '').trim().slice(0, 60),
    paneHead: p ? (p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    slotErrors: Array.from(document.querySelectorAll('[data-slot-error]')).map(e => e.getAttribute('data-slot-error')),
  };
})()`));
await shot('f2-pane-open.png');

// 4b) 收起右栏：fullscreen 面板的 overlay 会盖住中央栏，鼠标事件到不了正文
const tg2 = await centerOf('[data-sidebar-right-toggle]');
if (tg2?.visible) { await clickAt(tg2.x, tg2.y); await sleep(2000); }
let rb2 = await run(`document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null`);
if (rb2 !== 'true') { await run(`document.querySelector('[data-sidebar-right-toggle]')?.click()`); await sleep(2000); }
note('05b-rightbar-collapsed', await run(`(() => ({
  collapsed: document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null,
  paneStillInDom: !!document.querySelector('.dsht-pane'),
  centerOccluded: (() => { const c = document.querySelector('.pI_x6G_centerCol'); if (!c) return null; const r = c.getBoundingClientRect(); const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + 40)); return el ? el.tagName + '.' + (el.className||'').toString().slice(0,40) : null; })(),
}))()`));

// 5) 注入 markdown 英文（优先放进会话；会话没挂载时退回到可见容器）
const inj = await run(`(() => {
  const conv = document.querySelector('[data-slot="conversation.session"]');
  const scope = conv && conv.textContent.length > 0 ? conv : document.querySelector('.pI_x6G_centerCol') || document.body;
  // 用真实存在的 markdown 类名，保证 watch.js 的 insideChatSurface 判定与真实正文一致
  const md = document.querySelector('[class*="_markdown_"]');
  const cls = md ? md.className : 'md _markdown_probe_1';
  const wrap = document.createElement('div');
  wrap.id = 'dsht-e2e-probe';
  wrap.className = cls;
  wrap.style.cssText = 'position:relative;padding:6px 8px;margin:6px 0;width:340px;max-width:340px;';
  wrap.textContent = 'The plugin keeps every finished translation in a small local cache, so selecting the same passage twice never spends a second model call.';
  const hosts = Array.from(scope.querySelectorAll('div')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 200 && r.height > 30 && r.top > 120 && r.bottom < window.innerHeight - 60 && r.left > 282 && r.left < 560;
  });
  const host = hosts[hosts.length - 1] || document.querySelector('.pI_x6G_centerCol') || document.body;
  host.appendChild(wrap);
  const r = wrap.getBoundingClientRect();
  // 遮挡自检：中心点上的元素必须还是探针自己
  const mid = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return {
    ok: true,
    cls: String(cls).slice(0, 50),
    scope: scope === conv ? 'conversation' : 'centerCol-fallback',
    host: host.tagName + '.' + (host.className || '').toString().slice(0, 40),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    centerHit: mid ? mid.tagName + '.' + (mid.className || '').toString().slice(0, 40) : null,
    occluded: mid !== wrap && !wrap.contains(mid),
  };
})()`);
note('06-injected', inj);

// 6) 划选注入的英文
const sel = await run(`(() => {
  const el = document.getElementById('dsht-e2e-probe');
  if (!el) return { ok: false, why: 'probe gone' };
  const node = el.firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(120, node.nodeValue.length));
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  const r = range.getBoundingClientRect();
  return { ok: true, text: node.nodeValue.slice(0, 80), x: Math.round(r.right), y: Math.round(r.bottom), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
})()`);
note('07-selection', sel);
if (!sel?.ok) { await shot('f3-noselect.png'); }
else {
  // CDP 派发的 mousePressed 会让浏览器把选区 collapse 成插入符，所以先派鼠标事件、再设置选区
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: sel.x, y: sel.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(300);
  const reselect = await run(`(() => {
    const el = document.getElementById('dsht-e2e-probe');
    if (!el) return { ok: false, why: 'probe gone' };
    const node = el.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(120, node.nodeValue.length));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    const r = range.getBoundingClientRect();
    // 程序化设置选区不会产生 mouseup，监听器需要这个合成事件才会读选区
    const ev = new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: Math.round(r.right) - 6, clientY: Math.round(r.bottom) - 6, button: 0, buttons: 0 });
    document.dispatchEvent(ev);
    return { ok: true, selectedLen: s.toString().length, x: Math.round(r.right), y: Math.round(r.bottom), dispatched: ev.type };
  })()`);
  note('07a-reselected', reselect);
  await sleep(1500);
  note('07b-after-mouseup', await run(`(() => {
    const s = window.getSelection();
    const probe = document.getElementById('dsht-e2e-probe');
    const anchor = s && s.anchorNode;
    return {
      probeStillThere: !!probe,
      rangeCount: s ? s.rangeCount : null,
      isCollapsed: s ? s.isCollapsed : null,
      selectedLen: s ? s.toString().length : null,
      selectedHead: s ? s.toString().slice(0, 50) : null,
      anchorInProbe: !!(anchor && probe && probe.contains(anchor)),
      triggerEls: document.querySelectorAll('.dsht-trigger').length,
      triggerText: (document.querySelector('.dsht-trigger')?.innerText || '').replace(/\\s+/g, ' ').trim() || null,
      uiNodes: document.querySelectorAll('[data-dsh-translator-ui]').length,
    };
  })()`));
}

// 7) 浮动「译」按钮
const pill = await run(`(() => {
  const el = document.querySelector('.dsht-trigger');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { text: (el.innerText || '').replace(/\\s+/g, ' ').trim(), title: (el.getAttribute('title') || '').slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.width > 0 && r.height > 0 };
})()`);
note('08-pill', pill);
await shot('f3-pill.png');

if (pill?.visible && !/已是中文/.test(pill.text || '')) {
  await clickAt(pill.x, pill.y);
  console.log('clicked 译 — waiting for SSE');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const c = await run(`(document.querySelector('.dsht-pane .dsht-count')?.innerText || '').trim()`);
    if (i % 6 === 5) console.log(`  t=${i + 1}s count="${c}"`);
    if (c && !/^0 /.test(c)) { if (i > 1) break; }
  }
}
await shot('f4-translated.png');

// 9) 最终取证
const final = await run(`(() => {
  const p = document.querySelector('.dsht-pane');
  const refs = p ? Array.from(p.querySelectorAll('[class*="dsht-card"], [class*="dsht-ref"], article, li')) : [];
  return {
    count: p ? (p.querySelector('.dsht-count')?.innerText || '').trim() : null,
    paneText: p ? (p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200) : null,
    paneHtml: p ? p.innerHTML.slice(0, 2600) : null,
    refNodes: refs.length,
    slotErrors: Array.from(document.querySelectorAll('[data-slot-error]')).map(e => e.getAttribute('data-slot-error')),
    stripTabs: (document.querySelector('[data-dockkit-strip-tabs]')?.innerText || '').trim().slice(0, 60),
  };
})()`);
note('09-final', { count: final.count, refNodes: final.refNodes, slotErrors: final.slotErrors, stripTabs: final.stripTabs });
console.log('\n=== REF CARD DIAG ===');
console.log(JSON.stringify(await run(`(window.__DSHT_REFS__ || []).slice(-4)`), null, 2).slice(0, 4000));
console.log('\n=== RENDER-PANE ARGS (what renderPane really got) ===');
console.log(JSON.stringify(await run(`(window.__DSHT_RENDER__ || []).slice(-4)`), null, 2).slice(0, 4000));
console.log('\n=== STORE STATE ===');
console.log(JSON.stringify(await run(`(() => {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/dsht|translator/i.test(k)) out[k] = (localStorage.getItem(k) || '').slice(0, 400);
    }
  } catch (e) { out.err = String(e); }
  return out;
})()`), null, 2).slice(0, 3000));
console.log('\n--- PANE TEXT ---\n' + (final.paneText || '(null)'));
console.log('\n--- PANE HTML ---\n' + (final.paneHtml || '(null)').slice(0, 1800));
console.log('\n--- exceptions ---\n' + (exceptions.join('\n') || '(none)'));
console.log('\n--- console tail 30 ---\n' + (consoleLines.slice(-30).join('\n') || '(none)'));

const cleaned = await run(`(() => { const el = document.getElementById('dsht-e2e-probe'); if (el) { el.remove(); return 'removed'; } return 'nothing'; })()`);
console.log('cleanup:', cleaned);
writeFileSync(join(OUT, 'full-flow.json'), JSON.stringify({ stage, sel, pill, final, exceptions, consoleLines }, null, 2), 'utf8');
ws.close();
process.exit(0);

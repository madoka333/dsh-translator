// tools/cdp-composer-flow.mjs — beta 专属：右侧栏「翻译」页签**最底部输入框**的端到端取证。
//
// 验的是四件事：
//   1. 输入框真的是面板的最后一个子节点（"最底下"这条需求本身）
//   2. 聚焦 → 输入 → 真 Enter → 卡片出现且 sourceLabel 是「手动输入」、译文是中文
//   3. 提交后输入框被清空
//   4. 「输入暂存」：打一半不提交 → 刷新页面 → 重开页签 → 那段字还在
//
// 复用了 cdp-full-flow.mjs 里踩过坑的导航步骤（会话打开 / 右栏展开 / 点「翻译」页签）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
mkdirSync(OUT, { recursive: true });

const DRAFT = 'Let me check the repository layout first.';
const COMMIT = 'The plugin keeps every finished translation in a small local cache.';

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
  try { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64')); console.log('shot ->', name); }
  catch { /* evidence only */ }
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
const note = (k, v) => console.log(`[${k}]`, JSON.stringify(v));

/** The pane, the composer and whether the composer is the pane's last element. */
const composerFacts = () => run(`(() => {
  const pane = document.querySelector('.dsht-pane');
  const box = document.querySelector('.dsht-composer');
  const area = document.querySelector('.dsht-input');
  if (!pane) return { pane: false };
  const kids = Array.from(pane.children);
  const r = box ? box.getBoundingClientRect() : null;
  const pr = pane.getBoundingClientRect();
  return {
    pane: true,
    composer: !!box,
    textarea: !!area,
    lastChildIsComposer: kids.length > 0 && kids[kids.length - 1] === box,
    lastChildClass: kids.length ? String(kids[kids.length - 1].className) : null,
    value: area ? area.value : null,
    disabled: (() => { const b = box && box.querySelector('button'); return b ? b.disabled : null; })(),
    pinnedToBottom: r !== null && Math.abs(r.bottom - pr.bottom) < 24,
    paneTail: (pane.innerText || '').replace(/\\s+/g, ' ').trim().slice(-80),
  };
})()`);

/** Focus the box and type through the real input path (fires input events React sees). */
const typeInto = async (text) => {
  const c = await centerOf('.dsht-input');
  if (c?.visible) await clickAt(c.x, c.y);
  else await run(`document.querySelector('.dsht-input')?.focus()`);
  await sleep(200);
  await send('Input.insertText', { text });
  await sleep(400);
};

const pressEnter = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === 'keyDown' ? '\r' : undefined,
    });
  }
  await sleep(600);
};

/** Open a session and land on the 翻译 tab; reused before and after the reload. */
async function openTranslatorPane() {
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
  let rb = await run(`document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null`);
  if (rb === 'true') { await run(`document.querySelector('[data-sidebar-right-toggle]')?.click()`); await sleep(2500); }

  const g = await centerOf('[data-sidebar-right-guide-entry="translator"]');
  if (g?.visible) await clickAt(g.x, g.y);
  else await run(`document.querySelector('[data-sidebar-right-guide-entry="translator"]')?.click()`);
  await sleep(3000);
}

await send('Runtime.enable');
await send('Page.enable');

// ---- 0) an EMPTY pane: the box must still be the pane's bottom edge ---------
// Regression, found by looking at the screenshot rather than the DOM: with no
// references the list is not rendered and nothing else grew, so the composer floated
// up the panel and left a screenful of slack under it. "最底下" has to hold in both
// states, so the flow starts from a cleared, empty pane on purpose.
await run(`(() => {
  const dead = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('dsh-translator:')) dead.push(k);
  }
  dead.forEach((k) => localStorage.removeItem(k));
  return dead;
})()`);
await send('Page.reload', { ignoreCache: true });
await openTranslatorPane();
const emptyFacts = await composerFacts();
const emptyCards = await run(`document.querySelectorAll('.dsht-card').length`);
note('00-empty-pane', { ...emptyFacts, cards: emptyCards });
await shot('h0-empty.png');

// ---- 1) the box is really the pane's bottom edge ---------------------------
const facts = await composerFacts();
note('01-composer', facts);
await shot('h1-composer.png');

// ---- 2) stage a draft, do NOT commit --------------------------------------
await typeInto(DRAFT);
const staged = await composerFacts();
note('02-staged', { value: staged.value, buttonEnabled: staged.disabled === false });

// ---- 3) reload: the draft must survive (输入暂存) ---------------------------
await send('Page.reload', { ignoreCache: true });
await openTranslatorPane();
const restored = await composerFacts();
note('03-restored', { value: restored.value });

// ---- 4) commit with a real Enter ------------------------------------------
await run(`(() => { const a = document.querySelector('.dsht-input'); if (a) { a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
await sleep(300);
await typeInto(COMMIT);
const beforeEnter = await composerFacts();
note('04-before-enter', { value: beforeEnter.value, buttonEnabled: beforeEnter.disabled === false });

await pressEnter();
let done = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  done = await run(`(() => {
    const pane = document.querySelector('.dsht-pane');
    const card = pane && pane.querySelector('.dsht-card');
    return {
      cards: pane ? pane.querySelectorAll('.dsht-card').length : 0,
      status: card ? (card.querySelector('.dsht-badge')?.getAttribute('data-state') ?? null) : null,
      label: card ? (card.querySelector('.dsht-meta span')?.innerText || '').trim() : null,
      out: card ? (card.querySelector('.dsht-out')?.innerText || '').trim() : null,
      value: document.querySelector('.dsht-input') ? document.querySelector('.dsht-input').value : null,
      paneText: pane ? (pane.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
    };
  })()`);
  if (done && done.status === 'done') break;
}
note('05-after-enter', done);
await shot('h2-committed.png');

// ---- 5) the draft store must be clean for the committed text ---------------
const storage = await run(`(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('dsh-translator:draft:')) out[k] = localStorage.getItem(k);
  }
  return out;
})()`);
note('06-draft-keys', storage);

const failures = [];
if (emptyCards !== 0) failures.push(`the empty-state step started with ${emptyCards} card(s)`);
if (emptyFacts.composer !== true) failures.push('(empty pane) no composer');
if (emptyFacts.lastChildIsComposer !== true) failures.push(`(empty pane) composer is not the last child (last=${emptyFacts.lastChildClass})`);
if (emptyFacts.pinnedToBottom !== true) failures.push('(empty pane) composer is NOT pinned to the bottom — the regression this step exists for');
if (!facts.composer) failures.push('no composer in the pane');
if (!facts.textarea) failures.push('no textarea');
if (facts.lastChildIsComposer !== true) failures.push(`composer is not the pane's last child (last=${facts.lastChildClass})`);
if (facts.pinnedToBottom !== true) failures.push('composer is not pinned to the pane bottom');
if (staged.disabled !== false) failures.push('the send button did not enable for staged text');
if (restored.value !== DRAFT) failures.push(`draft did not survive the reload (got ${JSON.stringify(restored.value)})`);
if (beforeEnter.disabled !== false) failures.push('the send button did not enable before Enter');
if (done?.cards !== 1) failures.push(`expected exactly one card, got ${done?.cards}`);
if (done?.status !== 'done') failures.push(`the card never finished (status=${done?.status})`);
if (done?.label !== '手动输入') failures.push(`expected the 手动输入 label, got ${JSON.stringify(done?.label)}`);
if (!/[\u4e00-\u9fff]/.test(done?.out ?? '')) failures.push(`no Chinese translation in the card: ${JSON.stringify(done?.out)}`);
if (done?.value !== '') failures.push(`the box was not cleared after commit (got ${JSON.stringify(done?.value)})`);
if (Object.keys(storage ?? {}).length !== 0) failures.push(`a draft key survived the commit: ${JSON.stringify(storage)}`);

console.log('--- exceptions ---');
console.log(exceptions.length === 0 ? '(none)' : exceptions.slice(0, 3).join('\n'));
if (failures.length > 0) {
  console.log('COMPOSER FLOW FAILED:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('COMPOSER FLOW PASSED');

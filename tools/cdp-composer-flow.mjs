// tools/cdp-composer-flow.mjs — beta 专属端到端取证：底部输入框 + 语言对 x→y + 翻译挡位。
//
// 验的是这些事：
//   1. 输入框真的是面板的最后一个子节点（"最底下"这条需求本身）
//   2. 聚焦 → 输入 → 真 Enter → 卡片出现且 sourceLabel 是「手动输入」、译文是中文
//   3. 提交后输入框被清空
//   4. 「输入暂存」：打一半不提交 → 刷新页面 → 重开页签 → 那段字还在
//   5. 语言对是 x→y：两个下拉 + 中间箭头 + 交换按钮；交换在源为「自动检测」时把源钉成
//      原目标、目标改成识别出来的语言；已被目标语言"覆盖"的卡片不会被重译成废话
//   6. 挡位：切换后同一张卡片按新挡位重译，且卡片上写着自己的挡位
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

// ---- 6) the x→y pair, and the swap button's two behaviours ------------------
// The pair is read off the real controls (data-role), not off the settings blob:
// what matters is what the user can see and click.
const pairFacts = () => run(`(() => {
  const pane = document.querySelector('.dsht-pane');
  if (!pane) return { pane: false };
  const val = (role) => { const el = pane.querySelector('[data-role=' + role + ']'); return el ? el.value : null; };
  const card = pane.querySelector('.dsht-card');
  const arrow = pane.querySelector('.dsht-arrow');
  return {
    pane: true,
    source: val('source'),
    target: val('target'),
    gear: val('mode'),
    hasSwap: !!pane.querySelector('[data-role=swap]'),
    arrow: arrow ? arrow.textContent.trim() : null,
    sourceOptions: pane.querySelector('[data-role=source]') ? pane.querySelector('[data-role=source]').options.length : 0,
    targetOptions: pane.querySelector('[data-role=target]') ? pane.querySelector('[data-role=target]').options.length : 0,
    cardCount: pane.querySelectorAll('.dsht-card').length,
    cardStatus: card ? (card.querySelector('.dsht-badge')?.getAttribute('data-state') ?? null) : null,
    chip: card ? (card.querySelector('.dsht-langpair')?.innerText || '').replace(/\\s+/g, ' ').trim() : null,
  };
})()`);

/** Set a select the way React sees it (native setter + change), then settle. */
const setSelect = async (role, value) => {
  const applied = await run(`(() => {
    const el = document.querySelector('.dsht-pane [data-role=' + ${JSON.stringify(role)} + ']');
    if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(1200);
  return applied;
};

const pairBefore = await pairFacts();
note('06-pair-initial', pairBefore);
const swapBox = await centerOf('.dsht-pane [data-role=swap]');
if (swapBox?.visible) await clickAt(swapBox.x, swapBox.y);
else await run(`document.querySelector('.dsht-pane [data-role=swap]')?.click()`);
await sleep(1500);
const pairSwapped = await pairFacts();
note('06a-pair-swapped', pairSwapped);
await shot('h4-swapped.png');
// Back to the default pair through the SETTINGS + a reload, not through the
// controls: the point here is to restore the starting state for the steps below
// without paying for a re-translation of every card.
await run(`(() => {
  const key = 'dsh-translator:settings';
  const s = JSON.parse(localStorage.getItem(key) || '{}');
  s.sourceLanguage = 'auto';
  s.targetLanguage = 'zh-CN';
  localStorage.setItem(key, JSON.stringify(s));
  return s;
})()`);
await send('Page.reload', { ignoreCache: true });
await openTranslatorPane();
const pairRestored = await pairFacts();
note('06b-pair-restored', pairRestored);

// ---- 7) the gear: switching it re-translates the cards under the new gear ----
const gearBefore = await pairFacts();
note('07-gear-before', gearBefore);
await setSelect('mode', 'academic');
let gearAfter = null;
for (let i = 0; i < 40; i++) {
  gearAfter = await pairFacts();
  if (gearAfter?.cardStatus === 'done' && /学术/.test(gearAfter?.chip ?? '')) break;
  await sleep(1000);
}
note('07a-gear-academic', gearAfter);
await shot('h5-gear.png');

// ---- 5b) fill the list, so the card/list design can be reviewed under load ----
const MORE = ['Reasoning about the tradeoffs takes longer than the edit itself.', 'Latency matters more than throughput for an interactive panel.'];
for (const text of MORE) {
  await typeInto(text);
  await pressEnter();
}
let listState = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  listState = await run(`(() => {
    const pane = document.querySelector('.dsht-pane');
    const cards = pane ? Array.from(pane.querySelectorAll('.dsht-card')) : [];
    return {
      cards: cards.length,
      done: cards.filter((c) => c.querySelector('.dsht-badge')?.getAttribute('data-state') === 'done').length,
      listScrolls: (() => { const l = document.querySelector('.dsht-list'); return l ? l.scrollHeight > l.clientHeight : null; })(),
      composerBottom: (() => { const b = document.querySelector('.dsht-composer'); const p = pane; if (!b || !p) return null; return Math.round(p.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom); })(),
    };
  })()`);
  if (listState && listState.cards === 3 && listState.done === 3) break;
}
note('05b-list', listState);
await shot('h3-list.png');

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
if (listState?.cards !== 3) failures.push(`expected three cards after two more commits, got ${listState?.cards}`);
if (listState?.done !== 3) failures.push(`expected three finished cards, got ${listState?.done}`);
if (!(listState?.composerBottom >= 0 && listState.composerBottom < 24)) {
  failures.push(`the composer drifted off the pane bottom by ${listState?.composerBottom}px`);
}
if (Object.keys(storage ?? {}).length !== 0) failures.push(`a draft key survived the commit: ${JSON.stringify(storage)}`);

// The x→y pair: the shape itself, then the swap semantics.
if (pairBefore?.source !== 'auto') failures.push(`the source did not start on 自动检测 (got ${pairBefore?.source})`);
if (pairBefore?.target !== 'zh-CN') failures.push(`the target did not start on Chinese (got ${pairBefore?.target})`);
if (pairBefore?.gear !== 'general') failures.push(`the gear did not start on 通用 (got ${pairBefore?.gear})`);
if (pairBefore?.arrow !== '→') failures.push(`the pair has no arrow between its two ends (got ${JSON.stringify(pairBefore?.arrow)})`);
if (pairBefore?.hasSwap !== true) failures.push('the pair has no swap button');
if (!(pairBefore?.sourceOptions >= 15)) failures.push(`the source list is short (${pairBefore?.sourceOptions} options)`);
if (pairBefore?.targetOptions !== pairBefore?.sourceOptions - 1) {
  failures.push('the target list must offer one language fewer: "auto" is not a language');
}
// Swapping with the source on 自动检测 pins the source and aims at what was
// recognised (the card is English), which is the "now let me write back" gesture.
if (pairSwapped?.source !== 'zh-CN') failures.push(`swap did not pin the source to the old target (got ${pairSwapped?.source})`);
if (pairSwapped?.target !== 'en') failures.push(`swap did not aim at the recognised language (got ${pairSwapped?.target})`);
// ...and it must NOT have re-translated the English card into English: that card
// would have been refused as "already the target", so it is left as it is.
if (pairSwapped?.cardCount !== 1) failures.push(`the swap changed the card count (${pairSwapped?.cardCount})`);
if (!/English → 简体中文/.test(pairSwapped?.chip ?? '')) {
  failures.push(`the card kept its own pair through a swap (chip=${JSON.stringify(pairSwapped?.chip)})`);
}
if (pairRestored?.source !== 'auto' || pairRestored?.target !== 'zh-CN') {
  failures.push(`the pair did not survive a reload (got ${pairRestored?.source} → ${pairRestored?.target})`);
}
// The gear: one card, re-run under the new gear, chip updated, no duplicate.
if (gearAfter?.gear !== 'academic') failures.push(`the gear select did not take (got ${gearAfter?.gear})`);
if (gearAfter?.cardCount !== 1) failures.push(`the gear switch duplicated the card (${gearAfter?.cardCount})`);
if (gearAfter?.cardStatus !== 'done') failures.push(`the card never finished under the new gear (${gearAfter?.cardStatus})`);
if (!/→ 简体中文 · 学术/.test(gearAfter?.chip ?? '')) {
  failures.push(`the card does not report its gear (chip=${JSON.stringify(gearAfter?.chip)})`);
}

console.log('--- exceptions ---');
console.log(exceptions.length === 0 ? '(none)' : exceptions.slice(0, 3).join('\n'));
// Close the CDP socket and LEAVE. The open WebSocket holds the event loop, so a
// passing run that only prints its verdict never exits — which looks exactly like a
// hung verification. The failure path below already exits for the same reason.
ws.close();
if (failures.length > 0) {
  console.log('COMPOSER FLOW FAILED:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('COMPOSER FLOW PASSED');
process.exit(0);

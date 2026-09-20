// tools/cdp-dig.mjs
// 深挖脚本：在真页面里定位右侧栏 / 座位 / 我们的面板节点，并输出有界 HTML。
// 只读（默认不改页面状态）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT = process.env.EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.evidence');
mkdirSync(OUT, { recursive: true });

const list = await (await fetch(CDP_HTTP + '/json/list')).json();
const target = list.find((t) => t.type === 'page' && /3080/.test(t.url));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('ws fail'));
});
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
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout ' + method));
      }
    }, 30000);
  });

const EXPR = String.raw`
(() => {
  const out = {};
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.getAttribute('class') || '').slice(0, 160),
    attrs: Array.from(el.attributes).map(a => a.name + '=' + String(a.value).slice(0, 120)),
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    children: el.children.length,
  });

  // 1) 我们的 UI 节点：自己 + 祖先链
  out.translatorUis = qa('[data-dsh-translator-ui]').map(el => {
    const chain = [];
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      chain.push({ tag: cur.tagName.toLowerCase(), attrs: Array.from(cur.attributes).map(a => a.name + '=' + String(a.value).slice(0, 100)) });
      cur = cur.parentElement;
    }
    return { self: desc(el), value: el.getAttribute('data-dsh-translator-ui'), ancestorChain: chain };
  });

  // 2) 右侧栏骨架
  out.rightbar = qa('[data-rightbar-col], [data-sidebar-right-mode], [data-sidebar-right-panel], [data-sidebar-right-toggle], [data-dsh-panel-host], [data-dsh-bottom-panel], [data-dsh-panel]').map(desc);

  // 3) 所有 data-slot 宿主及其内容摘要
  out.slots = qa('[data-slot]').map(el => ({ ...desc(el), slot: el.getAttribute('data-slot') }));

  // 4) 含「翻译」字样的节点
  out.byText = qa('*').filter(el => /翻译|划选|译文/.test(el.textContent || '') && el.children.length < 6).slice(0, 25)
    .map(el => ({ ...desc(el), html: el.outerHTML.slice(0, 800) }));

  // 5) 标签栏 / 页签按钮
  out.tabs = qa('[role=tab], button').filter(el => /翻译|预览|文件|Files|Preview|Translate/.test(el.textContent || '') || /tab/i.test(el.getAttribute('class') || '')).slice(0, 30).map(desc);

  // 6) data-plugin 节点里属于我们的
  out.ourPluginNodes = qa('[data-plugin]').filter(el => /translator/i.test(el.getAttribute('data-plugin') || '')).map(el => ({
    plugin: el.getAttribute('data-plugin'),
    ...desc(el),
    html: el.outerHTML.slice(0, 1500),
  }));
  out.pluginTally = (() => { const t = {}; for (const el of qa('[data-plugin]')) { const k = el.getAttribute('data-plugin'); t[k] = (t[k] || 0) + 1; } return t; })();

  // 7) 状态标志
  out.flags = {
    sidebarRightMode: document.querySelector('[data-sidebar-right-mode]')?.getAttribute('data-sidebar-right-mode') ?? null,
    rightbarCollapsed: document.querySelector('[data-rightbar-collapsed]')?.getAttribute('data-rightbar-collapsed') ?? null,
    hasUnavailable: qa('[data-sidebar-right-unavailable]').length,
    slotErrors: qa('[data-slot-error]').map(e => e.getAttribute('data-slot-error')),
    paneCount: qa('.dsht-pane').length,
  };
  return out;
})()
`;

const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
writeFileSync(join(OUT, 'dig.json'), JSON.stringify(r.result?.value ?? r, null, 2), 'utf8');
console.log(JSON.stringify(r.result?.value ?? r, null, 2).slice(0, 12000));
ws.close();
process.exit(0);

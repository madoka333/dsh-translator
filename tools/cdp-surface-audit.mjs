// tools/cdp-surface-audit.mjs — 量化 watch.js 的 insideChatSurface 在真实 DSH 会话里的命中率。
// 只读，不注入任何东西：遍历会话里所有文本节点，按插件同款规则判定，并列出真实类名/属性。
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
    }, 40000);
  });
const run = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
};

await send('Runtime.enable');

const AUDIT = String.raw`
(() => {
  // 与 src/client/watch.js 完全同款的判定
  const CHAT_HINT_RE = /(message|markdown|chat|conversation|reasoning|assistant|think)/i;
  const SKIP = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
  const inSurface = (node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement ?? null;
    let depth = 0;
    const chain = [];
    while (el !== null && depth < 24) {
      const cls = typeof el.className === 'string' ? el.className : '';
      chain.push(el.tagName + (cls ? '.' + cls.slice(0, 50) : '') + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : ''));
      if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-dsh-chat-area')) return { ok: true, why: 'data-dsh-chat-area', chain };
      if (CHAT_HINT_RE.test(cls)) return { ok: true, why: 'class-hint:' + cls.slice(0, 40), chain };
      const role = el.getAttribute?.('role');
      if (role === 'log' || role === 'list') return { ok: true, why: 'role:' + role, chain };
      el = el.parentElement;
      depth += 1;
    }
    return { ok: false, why: 'no-hint', chain };
  };

  const root = document.querySelector('[data-slot="conversation.session"]');
  if (!root) return { ok: false, why: 'no conversation mounted' };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = null;
  let total = 0, english = 0, englishInSurface = 0;
  const samples = [];
  const failChains = new Map();
  const passWhy = new Map();

  while ((n = walker.nextNode())) {
    total++;
    const t = n.nodeValue || '';
    const parent = n.parentElement;
    if (!parent || SKIP.has(parent.tagName)) continue;
    if (!/[A-Za-z]{4}/.test(t)) continue;
    const raw = t.replace(/\s+/g, ' ').trim();
    if (raw.length < 8) continue;
    const cjk = (raw.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    if (cjk / raw.length > 0.2) continue;
    english++;
    const verdict = inSurface(n);
    if (verdict.ok) {
      englishInSurface++;
      passWhy.set(verdict.why, (passWhy.get(verdict.why) || 0) + 1);
    } else {
      const key = verdict.chain.slice(0, 6).join(' > ');
      failChains.set(key, (failChains.get(key) || 0) + 1);
      if (samples.length < 5) samples.push({ text: raw.slice(0, 60), chain: verdict.chain.slice(0, 8) });
    }
  }

  // 有没有别的地方带这些提示
  const docHints = {
    dataDshChatArea: document.querySelectorAll('[data-dsh-chat-area]').length,
    roleLog: document.querySelectorAll('[role=log]').length,
    roleList: document.querySelectorAll('[role=list]').length,
  };
  const hintClasses = new Set();
  for (const el of root.querySelectorAll('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (CHAT_HINT_RE.test(cls)) hintClasses.add(cls.slice(0, 60));
  }

  return {
    ok: true,
    rootFound: true,
    totalTextNodes: total,
    englishCandidates: english,
    englishPassingSurfaceGate: englishInSurface,
    gatePassRate: english === 0 ? null : Math.round((englishInSurface / english) * 100) + '%',
    passReasons: Object.fromEntries(passWhy),
    topFailChains: [...failChains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([chain, count]) => ({ count, chain })),
    samples,
    docHints,
    hintClassesInsideConversation: [...hintClasses].slice(0, 10),
  };
})()
`;
const val = await run(AUDIT);
writeFileSync(join(OUT, 'surface-audit.json'), JSON.stringify(val, null, 2), 'utf8');
console.log(JSON.stringify(val, null, 2).slice(0, 7000));
ws.close();
process.exit(0);

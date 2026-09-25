// tools/cdp-crop.mjs — 放大裁切页面某一块，用来判读 UI 细节（颜色对比、对齐、1px 描边）。
//
// 整屏截图会把这些东西压缩到看不出，而"按钮到底在不在"这种问题光看 DOM 会得出错误结论
// （pointer-events:none 的装饰层在命中测试里不存在，却真的画在按钮上面）。
//
// 用法：
//   node tools/cdp-crop.mjs <x> <y> <w> <h> [scale] [name]
// 例：
//   node tools/cdp-crop.mjs 860 770 730 140 2.4 ui-crop-composer.png
const CDP_HTTP = 'http://127.0.0.1:9222';
const [x, y, w, h, scale, name] = process.argv.slice(2);
const list = await (await fetch(CDP_HTTP + '/json/list')).json();
const target = list.find((t) => t.type === 'page' && /3080/.test(t.url));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let nextId = 1; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 30000);
});
const s = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: Number(scale) },
});
const { writeFileSync } = await import('node:fs');
const out = `D:/data/dsh/dsh-translator/.evidence/${name}`;
writeFileSync(out, Buffer.from(s.data, 'base64'));
console.log('shot ->', out);
ws.close();

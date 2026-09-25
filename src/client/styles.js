/**
 * dsh-translator client styles, injected once per document.
 *
 * Colors come from DSH's own CSS custom properties so the pane follows the active
 * theme; every lookup has a literal fallback for the case where a variable is
 * renamed upstream.
 *
 * @module dsh-translator/client/styles
 */

/** Style tag id, used for the once-per-document guard. */
const STYLE_ID = 'dsh-translator-style'

/** Class-name prefix for every node this plugin owns. */
export const CLS = 'dsht'

const CSS = `
.${CLS}-trigger{
  position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;
  padding:5px 10px;border-radius:999px;cursor:pointer;user-select:none;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));
  background:var(--dsw-specific-menu,#1e2533);color:var(--dsw-alias-label-primary,#e6ebf2);
  font:500 12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);
  box-shadow:0 4px 16px rgba(0,0,0,.32);white-space:nowrap;
}
.${CLS}-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.${CLS}-trigger[data-drag]{cursor:grab}
.${CLS}-trigger b{color:var(--dsw-static-deepseek-400,#679efe);font-weight:700}
.${CLS}-pane{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;
  font:13px/1.6 var(--ds-font-family-body,system-ui,sans-serif);
  color:var(--dsw-alias-label-primary,#e6ebf2)}
.${CLS}-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;padding:2px 2px 6px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
.${CLS}-bar select,.${CLS}-bar button{
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,#c9d2e0);
  font:12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);padding:3px 8px;cursor:pointer}
.${CLS}-bar button:hover,.${CLS}-bar select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.${CLS}-bar .${CLS}-spacer{flex:1}
.${CLS}-count{color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:12px;white-space:nowrap}
.${CLS}-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0;padding:2px}
.${CLS}-drop{border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:10px;
  padding:10px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:12px}
.${CLS}-pane[data-dragover=true] .${CLS}-drop}{
  border-color:var(--dsw-static-deepseek-400,#679efe);color:var(--dsw-static-deepseek-400,#679efe)}
.${CLS}-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:12px;
  background:var(--dsw-specific-tip,rgba(128,128,128,.06));display:flex;flex-direction:column;gap:6px;padding:8px 10px}
.${CLS}-card[data-active=true]{border-color:var(--dsw-static-deepseek-400,#679efe)}
.${CLS}-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a94a6);
  flex-wrap:wrap}
.${CLS}-badge{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:999px;padding:0 6px}
.${CLS}-badge[data-state=streaming]{color:var(--dsw-static-deepseek-400,#679efe);border-color:currentColor}
.${CLS}-badge[data-state=done]{color:var(--dsw-alias-state-success-primary,#4ec9a0);border-color:currentColor}
.${CLS}-badge[data-state=error]{color:var(--dsw-alias-state-error-primary,#f0616d);border-color:currentColor}
.${CLS}-src{color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:12px;white-space:pre-wrap;
  word-break:break-word;max-height:96px;overflow:hidden;cursor:zoom-in}
.${CLS}-src[data-open=true]{max-height:none;cursor:zoom-out}
.${CLS}-out{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#e6ebf2)}
.${CLS}-out[data-empty=true]{color:var(--dsw-alias-label-tertiary,#8a94a6)}
.${CLS}-err{color:var(--dsw-alias-state-error-primary,#f0616d);font-size:12px;word-break:break-word}
.${CLS}-acts{display:flex;gap:6px;flex-wrap:wrap}
.${CLS}-acts button{all:unset;cursor:pointer;font-size:11px;padding:2px 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));
  color:var(--dsw-alias-label-secondary,#c9d2e0)}
.${CLS}-acts button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.${CLS}-empty{display:flex;flex-direction:column;gap:6px;padding:14px 10px;align-items:center;text-align:center;
  color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:12px;line-height:1.8;flex:1;justify-content:center;min-height:0}
.${CLS}-empty kbd{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:5px;
  padding:0 5px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.${CLS}-float{position:fixed;right:18px;bottom:calc(96px + var(--dsh-input-offset,0px));width:min(420px,42vw);
  max-height:60vh;display:flex;flex-direction:column;z-index:2147482990;
  background:var(--dsw-specific-menu,#1e2533);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));
  border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:10px;gap:8px}
.${CLS}-float header{display:flex;align-items:center;gap:8px;flex:none}
.${CLS}-float header strong{font-size:13px;font-weight:600}
.${CLS}-setting{display:flex;align-items:center;gap:10px;justify-content:space-between;
  padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
.${CLS}-setting small{display:block;color:var(--dsw-alias-label-tertiary,#8a94a6);font-size:11px;margin-top:2px}
.${CLS}-composer{display:flex;align-items:flex-end;gap:6px;flex:none;padding-top:2px}
.${CLS}-input{
  flex:1;min-width:0;box-sizing:border-box;resize:vertical;
  min-height:calc(2 * 1.6em + 12px);max-height:9em;overflow-y:auto;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:10px;
  background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.06));
  color:var(--dsw-alias-label-primary,#e6ebf2);
  font:12px/1.6 var(--ds-font-family-body,system-ui,sans-serif);padding:5px 8px}
.${CLS}-input:focus{outline:none;border-color:var(--dsw-static-deepseek-400,#679efe)}
.${CLS}-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a94a6)}
.${CLS}-composer button{
  flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:10px;
  background:transparent;color:var(--dsw-alias-label-secondary,#c9d2e0);
  font:12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);padding:5px 12px;cursor:pointer}
.${CLS}-composer button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.${CLS}-composer button:disabled{opacity:.45;cursor:default}
.${CLS}-beta{border:1px solid var(--dsw-static-deepseek-400,#679efe);color:var(--dsw-static-deepseek-400,#679efe);
  border-radius:999px;padding:0 6px;font-size:10px;letter-spacing:.04em;text-transform:uppercase}
`

/** Inject the stylesheet once per document. */
export function installStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = 'dsh-translator'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

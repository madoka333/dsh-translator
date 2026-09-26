/**
 * dsh-translator client styles, injected once per document.
 *
 * Colors come from DSH's own CSS custom properties so the pane follows the active
 * theme; every lookup has a literal fallback for the case where a variable is
 * renamed upstream.
 *
 * Three constraints shape this sheet:
 * - every selector is prefixed with {@link CLS}, so nothing here can reach the app;
 * - NO literal markup in the CSS (the build's JSX-leftover check scans the bundle
 *   for tag-shaped text, so an inline SVG chevron would be read as un-transformed
 *   JSX — the select's chevron is a ::after glyph instead);
 * - no hooks on class-name ORDER the tests read (dsht-pane → dsht-list/
 *   dsht-empty → dsht-drop → dsht-composer last), because that order is what
 *   keeps the composer on the pane's bottom edge.
 *
 * @module dsh-translator/client/styles
 */

/** Style tag id, used for the once-per-document guard. */
const STYLE_ID = 'dsh-translator-style'

/** Class-name prefix for every node this plugin owns. */
export const CLS = 'dsht'

/** Shared surface/typography tokens, so the rules below stay readable. */
const TOKENS = `
.${CLS}-pane,.${CLS}-float,.${CLS}-trigger,.${CLS}-setting{
  --${CLS}-surface:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));
  --${CLS}-line:var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  --${CLS}-line-strong:var(--dsw-alias-border-l1,rgba(128,128,128,.4));
  --${CLS}-text:var(--dsw-alias-label-primary,#e6ebf2);
  --${CLS}-dim:var(--dsw-alias-label-secondary,#c9d2e0);
  --${CLS}-faint:var(--dsw-alias-label-tertiary,#8a94a6);
  --${CLS}-accent:var(--dsw-static-deepseek-400,#679efe);
  --${CLS}-ok:var(--dsw-alias-state-success-primary,#4ec9a0);
  --${CLS}-bad:var(--dsw-alias-state-error-primary,#f0616d);
}
`

const CSS = `
${TOKENS}
.${CLS}-trigger{
  position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;
  padding:5px 11px;border-radius:999px;cursor:pointer;user-select:none;
  border:1px solid var(--${CLS}-line-strong);
  background:var(--dsw-specific-menu,#1e2533);color:var(--${CLS}-text);
  font:500 12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);
  box-shadow:0 4px 16px rgba(0,0,0,.32);white-space:nowrap;
}
.${CLS}-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.${CLS}-trigger[data-drag]{cursor:grab}
.${CLS}-trigger b{color:var(--${CLS}-accent);font-weight:700}

/* ---- pane shell ---------------------------------------------------------- */
.${CLS}-pane{
  display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;box-sizing:border-box;
  padding:10px 10px 8px;
  font:13px/1.6 var(--ds-font-family-body,system-ui,sans-serif);
  color:var(--${CLS}-text);
}

/* ---- toolbar ------------------------------------------------------------- */
.${CLS}-bar{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;
  padding-bottom:8px;border-bottom:1px solid var(--${CLS}-line);
}
.${CLS}-select{position:relative;display:inline-flex;align-items:center}
.${CLS}-select::after{
  content:'\\25BE';position:absolute;right:8px;pointer-events:none;
  color:var(--${CLS}-faint);font-size:9px;line-height:1}
.${CLS}-bar select{
  appearance:none;-webkit-appearance:none;padding:4px 24px 4px 9px;
  border:1px solid var(--${CLS}-line);border-radius:9px;background:transparent;
  color:var(--${CLS}-dim);font:12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);cursor:pointer}
.${CLS}-bar select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.${CLS}-bar select:focus-visible{outline:none;border-color:var(--${CLS}-accent)}
.${CLS}-bar button{
  border:1px solid var(--${CLS}-line);border-radius:9px;background:transparent;
  color:var(--${CLS}-dim);font:12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);
  padding:4px 10px;cursor:pointer}
.${CLS}-bar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.${CLS}-bar button:disabled{opacity:.45;cursor:default}
.${CLS}-bar .${CLS}-spacer{flex:1}
/* The x→y pair, then the gear: the shape every translation app uses, so the two
   ends of a translation are read as one control instead of as "some dropdown".
   The widths are clamp-ish on purpose — a sidebar can be dragged narrow, and a
   select that cannot shrink pushes 清空 out of the row. */
.${CLS}-pair{display:inline-flex;align-items:center;gap:4px;min-width:0}
.${CLS}-bar .${CLS}-pair select{max-width:104px}
.${CLS}-bar select[data-role=mode]{max-width:92px}
.${CLS}-arrow{flex:none;color:var(--${CLS}-faint);font-size:11px;line-height:1}
.${CLS}-bar .${CLS}-swap{flex:none;padding:4px 7px;font-size:12px;line-height:1.1}
.${CLS}-bar .${CLS}-swap:hover{
  color:var(--${CLS}-accent);border-color:color-mix(in srgb,var(--${CLS}-accent) 45%,transparent)}
.${CLS}-count{
  color:var(--${CLS}-faint);font-size:11px;white-space:nowrap;
  border:1px solid var(--${CLS}-line);border-radius:999px;padding:1px 8px}
/* The beta badge lived here while the branch was experimental; 0.2.0 shipped it, so
   the badge and its rule are gone together. (Note for the next editor: no backticks
   anywhere below — the whole sheet is one template literal, and a backtick in a
   comment terminates it early and takes the whole Web GUI down with it.) */

/* ---- reference list ------------------------------------------------------ */
.${CLS}-list{
  display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0;
  padding:2px;scrollbar-width:thin;scrollbar-color:var(--${CLS}-line-strong) transparent}
.${CLS}-list::-webkit-scrollbar{width:8px}
.${CLS}-list::-webkit-scrollbar-thumb{
  background:var(--${CLS}-line-strong);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.${CLS}-list::-webkit-scrollbar-track{background:transparent}

/* ---- empty state --------------------------------------------------------- */
.${CLS}-empty{
  display:flex;flex-direction:column;gap:8px;padding:18px 14px;align-items:center;text-align:center;
  color:var(--${CLS}-faint);font-size:12px;line-height:1.7;flex:1;justify-content:center;min-height:0}
.${CLS}-empty-glyph{
  display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:2px;
  border:1px solid var(--${CLS}-line);border-radius:14px;background:var(--${CLS}-surface);
  color:var(--${CLS}-accent);font-size:20px;font-weight:600}
.${CLS}-empty-lead{color:var(--${CLS}-dim);font-size:13px}
.${CLS}-empty kbd{
  border:1px solid var(--${CLS}-line);border-bottom-width:2px;border-radius:6px;
  padding:1px 6px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;
  color:var(--${CLS}-dim);background:var(--${CLS}-surface)}

/* ---- drag hint ----------------------------------------------------------- */
/* A always-on dashed box competed with the composer for the same "input" read, so
   the box only appears while something is actually being dragged over the pane. */
.${CLS}-drop{
  border:1px solid transparent;border-radius:10px;padding:5px 8px;text-align:center;
  color:var(--${CLS}-faint);font-size:11px;flex:none}
.${CLS}-pane[data-dragover=true] .${CLS}-drop{
  border-style:dashed;border-color:var(--${CLS}-accent);
  color:var(--${CLS}-accent);background:var(--${CLS}-surface)}

/* ---- composer ------------------------------------------------------------ */
/* The send button sits at the START of the row, not the end, and that is a
   constraint, not a taste call.
 *
 * This machine runs a decorative overlay (dsh-whale-widget: position fixed,
 * z-index 9999, pointer-events none) whose painted box covers the right pane's
 * bottom-right corner — exactly where a send button belongs. Because it is
 * pointer-events:none, nothing errors and hit-testing still finds the button; it is
 * simply PAINTED OVER and invisible.
 *
 * Raising this element is not possible from inside the pane: the pane sits under
 * _tabCell_* in ui-sidebar-right, which is a static flex/grid item carrying
 * z-index:10 — that already IS a stacking context, so any z-index here is capped
 * below the overlay. Only moving the control out of the covered corner works.
 * (Documented in README; if the widget is moved away, the button may return to the
 * conventional trailing position.)
 *
 * NOTE for whoever edits this sheet: NO backticks anywhere below. The whole block is
 * one JS template literal, so a backtick in a comment terminates it early — with an
 * odd count the bundle stops parsing, the client entry fails to IMPORT, and dsh's web
 * boot throws, taking the entire GUI down. tools/verify-build.mjs and the client
 * suite now guard both the parse and the stylesheet's integrity. */
.${CLS}-composer{
  display:flex;align-items:center;gap:6px;flex:none;
  border:1px solid var(--${CLS}-line);border-radius:12px;background:var(--${CLS}-surface);
  padding:6px 8px 6px 6px}
.${CLS}-composer:focus-within{border-color:color-mix(in srgb,var(--${CLS}-accent) 55%,transparent)}
.${CLS}-input{
  flex:1;min-width:0;box-sizing:border-box;resize:vertical;
  min-height:calc(2 * 1.6em + 8px);max-height:9em;overflow-y:auto;
  border:0;background:transparent;color:var(--${CLS}-text);
  font:12px/1.6 var(--ds-font-family-body,system-ui,sans-serif);padding:2px 2px 2px 0;
  scrollbar-width:thin;scrollbar-color:var(--${CLS}-line-strong) transparent}
.${CLS}-input:focus{outline:none}
.${CLS}-input::placeholder{color:var(--${CLS}-faint)}
.${CLS}-send{
  flex:none;border:1px solid var(--${CLS}-line);border-radius:9px;background:var(--${CLS}-surface);
  color:var(--${CLS}-dim);font:12px/1.4 var(--ds-font-family-body,system-ui,sans-serif);
  padding:4px 12px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.${CLS}-send:hover:not(:disabled){
  border-color:color-mix(in srgb,var(--${CLS}-accent) 45%,transparent);color:var(--${CLS}-accent);
  background:color-mix(in srgb,var(--${CLS}-accent) 12%,transparent)}
/* A transparent, 40%-opacity ghost on a dark surface is INVISIBLE — the box then reads
   as "a text field with no action". The disabled state keeps its own fill and only
   dims, so the control stays legible while it is unavailable. */
.${CLS}-send:disabled{opacity:.6;cursor:default}

/* ---- reference card ------------------------------------------------------ */
.${CLS}-card{
  border:1px solid var(--${CLS}-line);border-radius:12px;background:var(--dsw-specific-tip,rgba(128,128,128,.05));
  display:flex;flex-direction:column;gap:7px;padding:9px 11px;transition:border-color .12s ease}
.${CLS}-card:hover{border-color:var(--${CLS}-line-strong)}
.${CLS}-card[data-active=true]{border-color:var(--${CLS}-accent)}
.${CLS}-meta{
  display:flex;align-items:center;gap:7px;font-size:11px;color:var(--${CLS}-faint);flex-wrap:wrap}
.${CLS}-meta .${CLS}-spacer{flex:1}
.${CLS}-meta>span:first-child{color:var(--${CLS}-dim);font-weight:500}
/* The x→y chip of one card. It carries the pair in force at the moment that card
   was translated, plus the gear when it is not the default one — which is the
   only place that fact is visible after switching gears. */
.${CLS}-langpair{
  border:1px solid var(--${CLS}-line);border-radius:999px;padding:0 7px;line-height:1.6;
  color:var(--${CLS}-faint);white-space:nowrap}
.${CLS}-langpair:not([data-mode=general]){color:var(--${CLS}-dim);border-color:var(--${CLS}-line-strong)}
.${CLS}-badge{border:1px solid var(--${CLS}-line);border-radius:999px;padding:0 7px;line-height:1.6}
.${CLS}-badge[data-state=streaming]{color:var(--${CLS}-accent);border-color:currentColor}
.${CLS}-badge[data-state=done]{color:var(--${CLS}-ok);border-color:currentColor}
.${CLS}-badge[data-state=error]{color:var(--${CLS}-bad);border-color:currentColor}
.${CLS}-src{
  color:var(--${CLS}-faint);font-size:12px;white-space:pre-wrap;word-break:break-word;
  max-height:96px;overflow:hidden;cursor:zoom-in;
  border-left:2px solid var(--${CLS}-line);padding-left:9px}
.${CLS}-src[data-open=true]{max-height:none;cursor:zoom-out}
.${CLS}-out{white-space:pre-wrap;word-break:break-word;color:var(--${CLS}-text);line-height:1.7}
.${CLS}-out[data-empty=true]{color:var(--${CLS}-faint)}
.${CLS}-err{color:var(--${CLS}-bad);font-size:12px;word-break:break-word}
.${CLS}-acts{
  display:flex;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--${CLS}-line)}
.${CLS}-acts button{
  all:unset;cursor:pointer;font-size:11px;padding:2px 8px;border-radius:7px;
  border:1px solid var(--${CLS}-line);color:var(--${CLS}-dim)}
.${CLS}-acts button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--${CLS}-text)}
.${CLS}-acts button:disabled{opacity:.4;cursor:default}
.${CLS}-acts button:last-child:hover{color:var(--${CLS}-bad);border-color:color-mix(in srgb,var(--${CLS}-bad) 45%,transparent)}

/* ---- floating fallback card ---------------------------------------------- */
.${CLS}-float{
  position:fixed;right:18px;bottom:calc(96px + var(--dsh-input-offset,0px));width:min(420px,42vw);
  max-height:60vh;display:flex;flex-direction:column;z-index:2147482990;
  background:var(--dsw-specific-menu,#1e2533);border:1px solid var(--${CLS}-line-strong);
  border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:10px;gap:8px}
.${CLS}-float header{display:flex;align-items:center;gap:8px;flex:none}
.${CLS}-float header strong{font-size:13px;font-weight:600}

/* ---- settings row -------------------------------------------------------- */
.${CLS}-setting{
  display:flex;align-items:center;gap:10px;justify-content:space-between;
  padding:10px 2px;border-bottom:1px solid var(--${CLS}-line)}
.${CLS}-setting small{display:block;color:var(--${CLS}-faint);font-size:11px;margin-top:2px}

@media (prefers-reduced-motion:reduce){
  .${CLS}-card,.${CLS}-send{transition:none}
}
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

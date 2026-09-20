/**
 * dsh-translator client read channel: the live conversation snapshot, used for
 * its metadata (which turn/step a selection came from) and — optionally — for a
 * one-click "translate this turn's reasoning" path.
 *
 * The primary path is still the user's own selection; everything here is best
 * effort and never blocks the plugin. Reads are structural: the `chat` target's
 * `legacy.partial` / `legacy.nodes` slice, the same projection DSH's own chat
 * renderer consumes.
 *
 * @module dsh-translator/client/chat
 */

/** The `chat` target key owned by ui-chat. */
const CHAT_TARGET = 'chat'

/**
 * Resolve the chat target source of one session.
 * @param uiConversation - the service, or undefined when absent.
 * @param sessionId - the session id.
 * @returns the source, or undefined when unaddressable.
 */
export function chatSourceFor(uiConversation, sessionId) {
  if (uiConversation === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return uiConversation.binding(sessionId).target(CHAT_TARGET)
  } catch {
    return undefined
  }
}

/**
 * Extract the assistant text/reasoning blocks of the CURRENT snapshot.
 *
 * Two sources are merged: the streaming `legacy.partial` (live deltas of the step
 * in flight) and the finalized `legacy.nodes`. Blocks are deduplicated by
 * (turn, step, kind, text) so a step that just finalized does not appear twice.
 *
 * @param snapshot - one chat snapshot, or undefined before activation.
 * @param options - `includeReasoning` / `includeText` gates.
 * @returns text units, oldest first: `{key, text, kind, turn, step, label}`.
 */
export function extractUnits(snapshot, options = {}) {
  const includeReasoning = options.includeReasoning !== false
  const includeText = options.includeText !== false
  if (snapshot === null || snapshot === undefined) return []

  const units = []
  const seen = new Set()

  const push = (block, turn, step, phase) => {
    if (block === null || block === undefined) return
    const kind = block.kind
    if (kind !== 'text' && kind !== 'reasoning') return
    if (kind === 'reasoning' && !includeReasoning) return
    if (kind === 'text' && !includeText) return
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text.length < 24) return
    const key = `${turn ?? '-'}:${step ?? '-'}:${kind}:${phase}:${text.length}`
    if (seen.has(key)) return
    seen.add(key)
    units.push({
      key,
      text,
      kind,
      turn,
      step,
      label: kind === 'reasoning' ? `第 ${turn ?? '?'} 轮 · Think` : `第 ${turn ?? '?'} 轮 · 正文`,
    })
  }

  const partial = snapshot?.legacy?.partial
  if (partial !== null && partial !== undefined) {
    for (const block of partial.blocks ?? []) push(block, partial.turn, partial.step, 'live')
  }

  const nodes = snapshot?.legacy?.nodes ?? []
  for (const node of nodes) {
    if (node?.kind !== 'assistant-step') continue
    const data = node.data ?? {}
    if (data.status === 'running') continue
    for (const block of data.blocks ?? []) push(block, data.turn, data.step, 'final')
  }

  return units
}

/** Read the live snapshot of one session's chat target, or undefined. */
export function readChatSnapshot(uiConversation, sessionId) {
  const source = chatSourceFor(uiConversation, sessionId)
  if (source === undefined) return undefined
  try {
    return source.getSnapshot()
  } catch {
    return undefined
  }
}

/**
 * The turn/step label for a selection, derived by locating the selection's own
 * text inside the live snapshot. Falls back to an empty label (the card simply
 * shows no provenance) — this is decoration, never a gate.
 * @param snapshot - one chat snapshot.
 * @param text - the selected text.
 * @returns a short Chinese label, or ''.
 */
export function provenanceFor(snapshot, text) {
  const needle = String(text ?? '').trim().slice(0, 40)
  if (needle === '') return ''
  const units = extractUnits(snapshot, {})
  for (const unit of units) {
    if (unit.text.includes(needle)) return unit.label
  }
  return ''
}

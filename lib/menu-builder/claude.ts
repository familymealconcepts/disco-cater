// One Claude call for the Menu Builder: Disco's own ANTHROPIC_API_KEY, the
// current Opus model, JSON-only output validated by the API against a schema
// (structured outputs — this model does not accept a forced tool choice).
// Streamed, because a full menu is tens of thousands of output tokens and a
// non-streamed request that long risks an idle-connection drop.

import type { ContentBlock } from './files'
import { recordApiCall } from './store'

// Model and price per the Anthropic models overview (checked 25 Oct 2026):
// Claude Opus 5.5 — $4 / million input tokens, $20 / million output tokens.
export const MENU_BUILDER_MODEL = 'claude-opus-5-5'
const PRICE_IN = 4 / 1_000_000
const PRICE_OUT = 20 / 1_000_000
const PRICE_CACHE_WRITE = 5 / 1_000_000
const PRICE_CACHE_READ = 0.2 / 1_000_000

export type Turn = { role: 'user' | 'assistant'; content: string | ContentBlock[] }

export async function callClaude<T>(opts: {
  sessionRef: string
  purpose: string
  system: string
  messages: Turn[]
  schema: Record<string, unknown>
  maxTokens?: number
}): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MENU_BUILDER_MODEL,
      max_tokens: opts.maxTokens ?? 64000,
      stream: true,
      system: opts.system,
      messages: opts.messages,
      output_config: { format: { type: 'json_schema', schema: opts.schema } },
    }),
  })
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(`Claude API ${res.status}: ${t.slice(0, 400)}`)
  }
  let text = ''
  let inTok = 0, outTok = 0, cacheW = 0, cacheR = 0
  let stop: string | null = null
  let streamError: string | null = null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SSE event / SQL row
      let ev: any
      try { ev = JSON.parse(line.slice(5)) } catch { continue }
      if (ev.type === 'message_start') {
        const u = ev.message?.usage || {}
        inTok = u.input_tokens || 0; cacheW = u.cache_creation_input_tokens || 0; cacheR = u.cache_read_input_tokens || 0
        outTok = u.output_tokens || 0
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text
      } else if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
      } else if (ev.type === 'error') {
        streamError = ev.error?.message || 'stream error'
      }
    }
  }
  const cost = inTok * PRICE_IN + outTok * PRICE_OUT + cacheW * PRICE_CACHE_WRITE + cacheR * PRICE_CACHE_READ
  await recordApiCall(opts.sessionRef, {
    at: new Date().toISOString(), purpose: opts.purpose, model: MENU_BUILDER_MODEL,
    input_tokens: inTok + cacheW + cacheR, output_tokens: outTok, cost_usd: Math.round(cost * 10000) / 10000,
  })
  if (streamError) throw new Error(`Claude API: ${streamError}`)
  if (stop === 'max_tokens') throw new Error('The answer was too long and got cut off. Try a smaller menu or fewer files per session.')
  if (stop === 'refusal') throw new Error('Claude declined this request.')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Claude returned something that was not valid JSON (${text.slice(0, 200)}…)`)
  }
}

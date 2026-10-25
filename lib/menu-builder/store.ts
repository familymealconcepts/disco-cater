// Menu Builder storage (Peter, 25 Oct 2026): one row per build/update session,
// and the Builder Rules with their full edit history.
//
// A session row is the review record Peter asked for: who ran it, which files
// (name/type/size/what the bot took each one to be — never the raw file), the
// prompts, every question and answer, what changed, and the API cost. Raw
// uploads are deleted from Blob as soon as the bot has read them (see
// lib/menu-builder/files.ts); only the bot's menu transcript is kept, and it
// is scrubbed of banking/tax identifiers before it is stored.

import { sql } from '../db'

let ensured = false
export async function ensureMenuBuilderTables(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_menu_builder_sessions (
      id SERIAL PRIMARY KEY,
      reference UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      actor_email TEXT NOT NULL,
      mode TEXT NOT NULL,                       -- 'new' | 'update'
      restaurant_refs JSONB NOT NULL,           -- [uuid, …]; the FIRST is where the draft is built
      restaurant_names JSONB NOT NULL,
      target_menu_name TEXT,                    -- update mode: the menu being changed
      target_menu_refs JSONB,                   -- update mode: { restaurantRef: menuRef }
      status TEXT NOT NULL,                     -- working | ready | error | published | applied | discarded
      status_note TEXT,
      files JSONB NOT NULL DEFAULT '[]',
      transcript TEXT,
      images JSONB NOT NULL DEFAULT '[]',       -- [{ name, url }] item photos, re-hosted
      messages JSONB NOT NULL DEFAULT '[]',
      spec JSONB,                               -- the bot's current menu
      draft_menu_ref UUID,                      -- new mode: the hidden draft at the first location
      pending_diff JSONB,                       -- update mode: before → after, not yet saved
      result JSONB,                             -- what Publish / Confirm actually did
      api_calls JSONB NOT NULL DEFAULT '[]',
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS disco_menu_builder_rules (
      id SERIAL PRIMARY KEY,
      rules TEXT NOT NULL,
      note TEXT,
      edited_by TEXT NOT NULL,
      edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  ensured = true
}

// ── Builder Rules ────────────────────────────────────────────────────────────
// The starting rules: what worked in the Almost Home Thanksgiving 2026 build
// (scripts/almost-home-thanksgiving-2026.ts) and the Chubby Group builds
// (scripts/chubby-menus-2026-10.ts). Written once, as the first history row;
// every later edit is a new row, so the history is the table.
export const SEED_RULES = `1. SIZES ARE ONE ITEM. A dish sold in sizes (half tray / full tray, small / medium / large, by the foot, pint / quart, 7" / 9") is ONE item, not one item per size. Its price is 0, its card display price is the LOWEST size price with a plus sign (e.g. "$45.00+"), and it gets one required option group titled "Select Size" with subtitle "Required", min 1 and max 1, with one option per size at that size's full price.
2. A dish with a single price gets that price and no size group and no display price.
3. READ EVERY TAB of every spreadsheet, including tabs that hold option groups, modifiers, add-ons or choices. Option-group tabs become option groups attached to the items they name; never drop a tab.
4. COPY STRUCTURE from the location's previous or archived menus of the same kind (e.g. last year's holiday menu): category names and order, how sizes are expressed, serving notes, tip default, lead time, service charge and fulfilment. Say which earlier menu you copied from.
5. HOLIDAY MENUS: availability CUSTOM covering only the pickup/delivery date(s), a hard cutoff date AND time in the restaurant's LOCAL time (e.g. order by Saturday 5 PM → hard_cutoff_date that Saturday, hard_cutoff_time "17:00"), and lead time 0 unless told otherwise. Do not repeat the order-by line in category descriptions.
6. A serving note that applies to a whole category (e.g. "Half feeds 8-10 | Full feeds 10-15") goes in the category description, not on every item.
7. Fill "serves" when the source says how many a dish feeds.
8. Use the restaurant's own wording for names and descriptions. Fix only obvious typos. Never invent ingredients or descriptions; if a description is missing, leave it empty and say so.
9. NEVER GUESS A PRICE. If a price is missing, unclear or contradictory, ask.
10. Keep the order the source lists things in, unless told otherwise.
11. Images come only from uploaded photos, matched to items by name. A photo of a printed menu is a source, never an item image.
12. Never put banking, tax, payout or personal identity information anywhere in a menu.`

export type RulesRow = { id: number; rules: string; note: string | null; edited_by: string; edited_at: string }

export async function currentRules(): Promise<RulesRow> {
  await ensureMenuBuilderTables()
  let rows = (await sql`SELECT id, rules, note, edited_by, edited_at FROM disco_menu_builder_rules ORDER BY id DESC LIMIT 1`) as RulesRow[]
  if (!rows.length) {
    await sql`
      INSERT INTO disco_menu_builder_rules (rules, note, edited_by)
      SELECT ${SEED_RULES}, 'Starting rules from the Almost Home Thanksgiving and Chubby builds', 'system'
      WHERE NOT EXISTS (SELECT 1 FROM disco_menu_builder_rules)`
    rows = (await sql`SELECT id, rules, note, edited_by, edited_at FROM disco_menu_builder_rules ORDER BY id DESC LIMIT 1`) as RulesRow[]
  }
  return rows[0]
}

export async function rulesHistory(): Promise<RulesRow[]> {
  await currentRules()
  return (await sql`SELECT id, rules, note, edited_by, edited_at FROM disco_menu_builder_rules ORDER BY id DESC LIMIT 200`) as RulesRow[]
}

export async function saveRules(rules: string, note: string | null, editedBy: string): Promise<RulesRow> {
  await ensureMenuBuilderTables()
  const [r] = (await sql`
    INSERT INTO disco_menu_builder_rules (rules, note, edited_by) VALUES (${rules}, ${note}, ${editedBy})
    RETURNING id, rules, note, edited_by, edited_at`) as RulesRow[]
  return r
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  questions?: string[]
  choices?: string[]
  at: string
}
export type FileNote = { name: string; type: string; size: number; kind?: string; note?: string }
export type ApiCall = { at: string; purpose: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }

export type SessionRow = {
  id: number
  reference: string
  actor_email: string
  mode: 'new' | 'update'
  restaurant_refs: string[]
  restaurant_names: string[]
  target_menu_name: string | null
  target_menu_refs: Record<string, string> | null
  status: string
  status_note: string | null
  files: FileNote[]
  transcript: string | null
  images: { name: string; url: string }[]
  messages: ChatMessage[]
  spec: unknown
  draft_menu_ref: string | null
  pending_diff: unknown
  result: unknown
  api_calls: ApiCall[]
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: string
  updated_at: string
}

export async function getSession(reference: string): Promise<SessionRow | null> {
  await ensureMenuBuilderTables()
  if (!/^[0-9a-f-]{36}$/i.test(reference)) return null
  const rows = (await sql`SELECT * FROM disco_menu_builder_sessions WHERE reference = ${reference}::uuid`) as SessionRow[]
  const r = rows[0]
  if (!r) return null
  return { ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cost_usd: Number(r.cost_usd) }
}

/** Patch a session. Only the listed fields can be written. */
export async function patchSession(reference: string, p: Partial<Pick<SessionRow,
  'status' | 'status_note' | 'files' | 'transcript' | 'images' | 'messages' | 'spec' | 'draft_menu_ref' | 'pending_diff' | 'result'>>): Promise<void> {
  const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
  await sql`
    UPDATE disco_menu_builder_sessions SET
      status = COALESCE(${p.status ?? null}, status),
      status_note = CASE WHEN ${p.status_note !== undefined} THEN ${p.status_note ?? null} ELSE status_note END,
      files = COALESCE(${j(p.files)}::jsonb, files),
      transcript = CASE WHEN ${p.transcript !== undefined} THEN ${p.transcript ?? null} ELSE transcript END,
      images = COALESCE(${j(p.images)}::jsonb, images),
      messages = COALESCE(${j(p.messages)}::jsonb, messages),
      spec = CASE WHEN ${p.spec !== undefined} THEN ${j(p.spec)}::jsonb ELSE spec END,
      draft_menu_ref = CASE WHEN ${p.draft_menu_ref !== undefined} THEN ${p.draft_menu_ref ?? null}::uuid ELSE draft_menu_ref END,
      pending_diff = CASE WHEN ${p.pending_diff !== undefined} THEN ${j(p.pending_diff)}::jsonb ELSE pending_diff END,
      result = CASE WHEN ${p.result !== undefined} THEN ${j(p.result)}::jsonb ELSE result END,
      updated_at = NOW()
    WHERE reference = ${reference}::uuid`
}

export async function recordApiCall(reference: string, call: ApiCall): Promise<void> {
  await sql`
    UPDATE disco_menu_builder_sessions SET
      api_calls = api_calls || ${JSON.stringify([call])}::jsonb,
      input_tokens = input_tokens + ${call.input_tokens},
      output_tokens = output_tokens + ${call.output_tokens},
      cost_usd = cost_usd + ${call.cost_usd},
      updated_at = NOW()
    WHERE reference = ${reference}::uuid`
}

/**
 * Claim the session for one background turn: only an idle session (not already
 * working, not finished) can be claimed, so a double-click cannot run two
 * turns over each other.
 */
export async function claimSession(reference: string, note: string): Promise<boolean> {
  const r = (await sql`
    UPDATE disco_menu_builder_sessions SET status = 'working', status_note = ${note}, updated_at = NOW()
    WHERE reference = ${reference}::uuid AND status IN ('ready', 'error')
    RETURNING 1`) as unknown[]
  return r.length > 0
}

// ── Banking / tax scrub ──────────────────────────────────────────────────────
// Belt and braces under the prompt's instruction never to transcribe them: any
// text the builder stores passes through here. Menus never legitimately carry
// an unbroken run of 8+ digits, an EIN-shaped (12-3456789) or SSN-shaped
// (123-45-6789) number, or an IBAN.
export function scrubSensitive(s: string): string {
  return s
    .replace(/\b\d{2}-\d{7}\b/g, '[removed]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[removed]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[removed]')
    .replace(/\d{8,}/g, '[removed]')
}

export function scrubDeep<T>(v: T): T {
  if (typeof v === 'string') return scrubSensitive(v) as T
  if (Array.isArray(v)) return v.map(scrubDeep) as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    // References, URLs and image names are ours (uuids / content hashes), and a
    // hex hash can contain a long digit run — never rewrite them.
    for (const [k, x] of Object.entries(v)) o[k] = k === 'ref' || k === 'url' || k === 'image' ? x : scrubDeep(x)
    return o as T
  }
  return v
}

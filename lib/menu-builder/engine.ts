// Menu Builder turns. Every turn runs in the background (the route returns at
// once and the page polls), records its cost on the session, and ends with the
// session back at 'ready' (or 'error' with the reason) — never left 'working'.

import { sql } from '../db'
import { callClaude, type Turn } from './claude'
import { ingest, rehostPhotos, deleteUploads, type Upload, type ContentBlock } from './files'
import { MENU_SPEC_SCHEMA, normalizeSpec, readMenuSpec, specToText, type MenuSpec } from './spec'
import { writeDraft, planUpdate } from './writer'
import { getSession, patchSession, currentRules, scrubSensitive, scrubDeep, type SessionRow, type ChatMessage } from './store'

const SYSTEM = `You are Disco's Menu Builder. Disco is a catering ordering platform. You turn a restaurant's files and instructions into a menu on Disco, or you change one of its existing menus.

WHAT YOU CAN DO: produce menu data only — the menu, its categories, items, prices, sizes and option groups, item photos (from uploaded photos only) and menu settings (availability dates, pickup windows, fulfilment, lead time, hard cutoff, tip default, service charge, order minimums). You cannot change restaurant settings, payments or Stripe, users or access, other restaurants, or anything else, and you never ask to. If a request needs any of that, say it is outside what you can do.

NEVER include banking, tax, payout or identity information (bank names, routing or account numbers, tax IDs/EINs, SSNs, W-9 details, void checks) anywhere in your output — not in the transcript, the menu, or your messages — even if a file contains it. Say only that a file looked like a banking/tax document and was ignored.

ALWAYS FOLLOW THE BUILDER RULES below. They are Disco's standing rules. If the user's instruction in this session conflicts with a rule, follow the user and say so in your choices.

QUESTIONS: ask about anything genuinely unclear that would change the menu — a missing or ambiguous price, which size an item is sold in, dates, pickup windows, cutoffs, fulfilment, items you cannot place, photos you cannot match. Each question is one short, specific line and ends with what you will do if not told otherwise, in brackets. Do not ask about things the rules, the files or the restaurant's earlier menus already answer. Never ask more than 15 at a time.

PHOTOS: an item's "image" is the exact file name of an uploaded item photo whose name or picture matches it; otherwise null. Never use a photo of a printed menu as an item image. Never invent a file name or a URL.

PRICES are US dollars as numbers (45, not "$45"). Times are 24-hour "HH:MM" in the restaurant's LOCAL time. Dates are YYYY-MM-DD.`

const BUILD_INSTRUCTIONS = `Respond with:
- reply: what you did or need, in a few plain sentences for a non-technical reader.
- action: "ask" when you are waiting for answers before building; "build" when you are returning a complete menu.
- menu: the COMPLETE menu (every category and item, not just the changes) when action is "build". When action is "ask", return a placeholder menu with name "" and no categories (it is ignored).
  In the menu, write "" for any empty text (description, serves, display price, image, subtitle, dates, ref) and 0 for "no minimum quantity" and "no daily order limit".
- choices: when building, every judgement call you made (what you assumed, what you copied from an earlier menu and which one, how you treated sizes, anything you left out), one per line. Otherwise [].
- questions: numbered follow-ups about anything still uncertain (missing photos, unclear prices, items you could not place). [] if none.
Build when the user says to, or when all questions that would change the menu are answered.`

const UPDATE_EXTRA = `This session UPDATES an existing menu. The menu as it is now is given as JSON with its refs. When you build, return the whole menu after the change, KEEPING every ref exactly as given for anything that still exists (categories, items, option groups); use ref null only for something new. Change only what the user asked for; everything else must come back exactly as it was (same names, prices, descriptions, images, settings). Nothing is saved until the user confirms the before → after list.`

const INGEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'transcript', 'files', 'photos', 'questions'],
  properties: {
    reply: { type: 'string' },
    transcript: { type: 'string' },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'kind', 'note'], properties: {
      name: { type: 'string' }, kind: { type: 'string', enum: ['menu', 'option_groups', 'item_photos', 'menu_photo', 'previous_menu', 'banking_or_tax_ignored', 'other_ignored'] }, note: { type: ['string', 'null'] } } } },
    photos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'kind', 'item'], properties: {
      file: { type: 'string' }, kind: { type: 'string', enum: ['item_photo', 'menu_page', 'other'] }, item: { type: ['string', 'null'] } } } },
    questions: { type: 'array', items: { type: 'string' } },
  },
}
type IngestOut = { reply: string; transcript: string; files: { name: string; kind: string; note: string | null }[]; photos: { file: string; kind: string; item: string | null }[]; questions: string[] }

const TURN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'action', 'menu', 'choices', 'questions'],
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['ask', 'build'] },
    menu: MENU_SPEC_SCHEMA,
    choices: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
}
type TurnOut = { reply: string; action: 'ask' | 'build'; menu: MenuSpec | null; choices: string[]; questions: string[] }

const now = () => new Date().toISOString()
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** The locations, their time zones, and every menu they have or had — the bot's reference for structure. */
async function locationContext(session: SessionRow): Promise<string> {
  const L: string[] = []
  let budget = 100_000
  for (const [i, rest] of session.restaurant_refs.entries()) {
    const c = (await sql`SELECT name, timezone FROM disco_restaurant_cache WHERE restaurant_reference::text = ${rest}`) as { name: string; timezone: string | null }[]
    L.push(`LOCATION ${i + 1}: ${c[0]?.name ?? rest} (time zone ${c[0]?.timezone || 'America/New_York'})${i === 0 && session.mode === 'new' ? ' — the draft is built here first' : ''}`)
    const menus = (await sql`
      SELECT reference::text AS reference, visible, archived, updated_at FROM disco_menus
       WHERE restaurant_reference = ${rest}::uuid ORDER BY archived ASC, updated_at DESC NULLS LAST LIMIT 40`) as { reference: string; visible: boolean; archived: boolean }[]
    if (!menus.length) L.push('  (no menus yet)')
    for (const m of menus) {
      if (session.draft_menu_ref && m.reference === session.draft_menu_ref) continue
      const r = await readMenuSpec(m.reference)
      if (!r) continue
      let t = specToText(r.spec)
      if (t.length > 12_000) t = `${t.slice(0, 12_000)}\n  [… rest of this menu cut]`
      const label = `  [${m.archived ? 'ARCHIVED' : r.visible ? 'LIVE' : 'HIDDEN'}] `
      if (budget - t.length < 0) { L.push(`${label}"${r.spec.name}" (not shown — context budget used)`); continue }
      budget -= t.length
      L.push(label + t.replace(/\n/g, '\n  '))
    }
  }
  return L.join('\n')
}

async function contextText(session: SessionRow): Promise<string> {
  const rules = await currentRules()
  const parts = [
    `TODAY: ${todayNY()}`,
    `MODE: ${session.mode === 'new' ? 'build a NEW menu' : `UPDATE the existing menu "${session.target_menu_name}"`} for ${session.restaurant_names.join(', ')}`,
    `BUILDER RULES (version ${rules.id}):\n${rules.rules}`,
    `THE LOCATIONS' EXISTING AND ARCHIVED MENUS (reference for structure and settings):\n${await locationContext(session)}`,
  ]
  if (session.mode === 'update' && session.target_menu_refs) {
    const target = await readMenuSpec(session.target_menu_refs[session.restaurant_refs[0]])
    if (target) parts.push(`THE MENU BEING UPDATED, AS IT IS NOW (JSON with refs — keep them):\n${JSON.stringify(target.spec)}`)
  }
  if (session.transcript) parts.push(`WHAT THE UPLOADED FILES SAY (your transcription):\n${session.transcript}`)
  if (session.images.length) parts.push(`UPLOADED ITEM PHOTOS (use these exact file names):\n${session.images.map(i => `- ${i.name}`).join('\n')}`)
  const unread = session.files.filter(f => f.note && /not read|could not|not supported|re-save|missing/.test(f.note))
  if (unread.length) parts.push(`FILES THAT COULD NOT BE READ:\n${unread.map(f => `- ${f.name}: ${f.note}`).join('\n')}`)
  return parts.join('\n\n')
}

/** Stored chat → API turns, merging any two same-role messages in a row. */
function history(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = []
  for (const m of messages) {
    const text = [m.text, ...(m.questions?.length ? ['Questions:', ...m.questions.map((q, i) => `${i + 1}. ${q}`)] : []), ...(m.choices?.length ? ['Choices made:', ...m.choices.map(c => `- ${c}`)] : [])].join('\n')
    const last = out[out.length - 1]
    if (last && last.role === m.role && typeof last.content === 'string') last.content += `\n\n${text}`
    else out.push({ role: m.role, content: text })
  }
  return out
}

async function fail(ref: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error('[menu-builder] turn failed:', ref, msg)
  await patchSession(ref, { status: 'error', status_note: scrubSensitive(msg).slice(0, 500) }).catch(() => {})
}

/** First turn: read the files, transcribe the menu content, sort the photos, ask questions. */
export async function runIngest(ref: string, uploads: Upload[], sheetLinks: string[]): Promise<void> {
  try {
    const session = await getSession(ref)
    if (!session) return
    if (!uploads.length && !sheetLinks.length) {
      await patchSession(ref, { status: 'ready', status_note: null })
      return runTurn(ref, true)
    }
    await patchSession(ref, { status_note: 'Reading the files…' })
    let got
    try { got = await ingest(uploads, sheetLinks) } finally { await deleteUploads(uploads) }
    const files = got.notes
    await patchSession(ref, { files, status_note: 'Reading the menu…' })
    const blocks: ContentBlock[] = [
      { type: 'text', text: await contextText({ ...session, files }) },
      { type: 'text', text: `THE UPLOADED FILES FOLLOW.` },
      ...got.blocks,
      { type: 'text', text: `THE USER'S INSTRUCTIONS:\n${session.messages[0]?.text || '(none)'}\n\nDo not build yet. Respond with:
- transcript: a complete, faithful transcription of EVERY piece of menu information in the files — every tab, page and photo of a printed menu: categories, items, descriptions, prices, sizes, option groups and choices, serving notes, dates, times, cutoffs, fulfilment. Keep each file's own structure and say which file/tab/page it came from. Leave out anything that is not menu information.
- files: what each file is.
- photos: for every photo file, whether it is an item photo (and which item it shows, by the item's name in the menu) or a photo of a printed menu page.
- reply: a short summary of what you found.
- questions: your numbered questions before building (see QUESTIONS). [] if you have none.` },
    ]
    const out = await callClaude<IngestOut>({ sessionRef: ref, purpose: 'read files', system: SYSTEM, messages: [{ role: 'user', content: blocks }], schema: INGEST_SCHEMA })
    const keep = new Set(out.photos.filter(p => p.kind === 'item_photo').map(p => p.file.toLowerCase()))
    const images = await rehostPhotos(got.photos, keep)
    const kinds = new Map(out.files.map(f => [f.name, f]))
    const notedFiles = files.map(f => ({ ...f, kind: kinds.get(f.name)?.kind, note: [f.note, kinds.get(f.name)?.note].filter(Boolean).join(' · ') || undefined }))
    const photoLines = out.photos.filter(p => p.kind === 'item_photo').map(p => `${p.file} → ${p.item ?? 'no matching item'}`)
    const s2 = (await getSession(ref))!
    await patchSession(ref, {
      status: 'ready', status_note: null,
      files: scrubDeep(notedFiles),
      transcript: scrubSensitive(out.transcript),
      images,
      messages: [...s2.messages, { role: 'assistant', text: scrubSensitive(out.reply), questions: scrubDeep(out.questions), choices: photoLines.length ? [`Item photos: ${photoLines.join('; ')}`] : undefined, at: now() }],
    })
  } catch (e) { await fail(ref, e) }
}

/** A chat turn: answers, "build it", or a change request. Builds/updates the hidden draft, or plans the update. */
export async function runTurn(ref: string, firstTurn = false): Promise<void> {
  try {
    const session = await getSession(ref)
    if (!session) return
    await patchSession(ref, { status: 'working', status_note: firstTurn ? 'Reading the menu…' : 'Thinking…' })
    const ctx = await contextText(session)
    const turns = history(session.messages)
    if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(start)' })
    turns[0] = { role: 'user', content: `${ctx}\n\nTHE USER'S INSTRUCTIONS:\n${turns[0].content}` }
    // The current draft, read back from Neon (what is actually saved), goes with the latest message.
    let draftNote = ''
    if (session.mode === 'new' && session.draft_menu_ref) {
      const d = await readMenuSpec(session.draft_menu_ref)
      if (d) draftNote = `\n\nTHE CURRENT HIDDEN DRAFT (JSON; change it as asked and return the whole menu):\n${JSON.stringify({ ...d.spec, categories: d.spec.categories.map(c => ({ ...c, ref: null, items: c.items.map(i => ({ ...i, ref: null, image: session.images.find(x => x.url === i.image)?.name ?? (i.image ? 'existing photo' : null), option_groups: i.option_groups.map(g => ({ ...g, ref: null })) })) })) })}`
    }
    const last = turns[turns.length - 1]
    if (last.role === 'assistant') turns.push({ role: 'user', content: 'Continue.' })
    turns[turns.length - 1] = { role: 'user', content: `${turns[turns.length - 1].content}${draftNote}\n\n${BUILD_INSTRUCTIONS}${session.mode === 'update' ? `\n\n${UPDATE_EXTRA}` : ''}` }

    await patchSession(ref, { status_note: 'Working on the menu…' })
    const out = await callClaude<TurnOut>({ sessionRef: ref, purpose: session.mode === 'new' ? 'build / change draft' : 'plan update', system: SYSTEM, messages: turns, schema: TURN_SCHEMA })

    let reply = out.reply
    let extraQuestions: string[] = []
    const patch: Parameters<typeof patchSession>[1] = {}
    if (out.action === 'build' && out.menu && out.menu.categories?.length) {
      const { spec, problems } = normalizeSpec(scrubDeep(out.menu))
      if (problems.length) {
        reply += `\n\nI did not save this version because: ${problems.join(' ')}`
        extraQuestions = problems.map(p => `${p} What should it be?`)
      } else if (session.mode === 'new') {
        await patchSession(ref, { status_note: 'Saving the hidden draft…' })
        const fresh = (await getSession(ref))!
        const draftRef = await writeDraft(fresh, spec)
        patch.draft_menu_ref = draftRef
        patch.spec = spec
      } else {
        await patchSession(ref, { status_note: 'Working out what would change…' })
        const plans = await planUpdate(session, spec)
        patch.spec = spec
        patch.pending_diff = { at: now(), plans }
      }
    }
    const s2 = (await getSession(ref))!
    await patchSession(ref, {
      ...patch,
      status: 'ready', status_note: null,
      messages: [...s2.messages, { role: 'assistant', text: scrubSensitive(reply), questions: scrubDeep([...out.questions, ...extraQuestions]), choices: out.action === 'build' ? scrubDeep(out.choices) : undefined, at: now() }],
    })
  } catch (e) { await fail(ref, e) }
}

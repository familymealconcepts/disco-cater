/**
 * Menus for the Chubby Group onboarding — called by
 * scripts/chubby-onboarding-2026-10.ts menus [--apply] [--only <key>].
 *
 * Source: each location's "...-New Catering Items" sheet (CSV) and its Photo
 * ZIP. The sheets are flat: one row per item (Category_EN, English Name,
 * Serving Size, Price, Item Describtion EN). They carry no sizes or option
 * lists, so no modifier groups are invented: an item whose description says
 * "Choose …" (party bundles, party-size trays, build-your-own) keeps that
 * wording and Special Instructions, and is reported as needing its options.
 *
 * Images come ONLY from that location's ZIP, matched to items by name: exact,
 * then with pack sizes ("12Pcs", "1Pc", "4-5Oz") removed. Anything else is
 * reported, never guessed.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, extname } from 'path'
import { put } from '@vercel/blob'
import { sql, runDiscoMenuMigrations } from '../lib/db'

// Store hours from the sheet — used ONLY to derive each menu's ordering window.
// (Disco stores no store hours of its own: the brand/website/store_hours
// columns briefly added for this onboarding were removed on Peter's
// instruction, 23 Oct 2026.)
export const STORE_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
export type StoreHours = Partial<Record<typeof STORE_DAYS[number], Array<{ open: string; close: string }>>>
function to24h(t: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*$/i.exec(t || '')
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'P') h += 12
  return `${String(h).padStart(2, '0')}:${m[2]}`
}
/** "12:00 PM - 2:00 PM; 5:00 PM - 9:15 PM" → windows; null if unreadable; blank/Closed → []. */
export function parseDayHours(text: string | null | undefined): Array<{ open: string; close: string }> | null {
  const s = String(text || '').trim()
  if (!s || /^closed$/i.test(s)) return []
  const out: Array<{ open: string; close: string }> = []
  for (const part of s.split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
    const [a, b] = part.split(/\s*[-–—]\s*/)
    const open = to24h(a || ''), close = to24h(b || '')
    if (!open || !close) return null
    out.push({ open, close })
  }
  return out
}
function hoursFromSheet(row: Record<string, string>): StoreHours {
  const raw: Record<string, string> = { SUNDAY: row.sun, MONDAY: row.mon, TUESDAY: row.tue, WEDNESDAY: row.wed, THURSDAY: row.thu, FRIDAY: row.fri, SATURDAY: row.sat }
  const h: StoreHours = {}
  for (const d of STORE_DAYS) { const w = parseDayHours(raw[d]); if (w) h[d] = w }
  return h
}

const DIR = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/32d3e220-b54a-4eef-b0a3-fc6cbc411db4/scratchpad/chubby'
const MENU_NAME = 'Catering Menu'
const NO_MENU = new Set(['chubby-cattle-bbq-atlanta']) // Peter: no menu for Atlanta

type Item = { category: string; name: string; serves: string | null; price: number | null; description: string }

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') q = false; else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const tidy = (s: string) => String(s || '').replace(/\s+/g, ' ').trim()
function loadItems(key: string): Item[] {
  const rows = parseCsv(readFileSync(join(DIR, 'menus', `${key}.csv`), 'utf8').replace(/^﻿/, ''))
  const h = rows[0].map(x => x.trim())
  const ix = (n: string) => h.indexOf(n)
  const out: Item[] = []
  for (const r of rows.slice(1)) {
    const name = tidy(r[ix('English Name')])
    if (!name) continue
    const p = Number(String(r[ix('Price')] || '').replace(/[$,\s]/g, ''))
    out.push({
      category: tidy(r[ix('Category_EN')]) || 'Menu',
      name, serves: tidy(r[ix('Serving Size')]) || null,
      price: Number.isFinite(p) && String(r[ix('Price')] || '').trim() !== '' ? Math.round(p * 100) / 100 : null,
      description: tidy(r[ix('Item Describtion EN')]),
    })
  }
  return out
}

// ── name matching ────────────────────────────────────────────────────────────
// Photo file names carry platform tags the menu names don't: "(Uber)", "(T)",
// weights "(250G_8.18Oz)", pack counts "(4Pcs)", and "W_" for "W/" (a slash
// can't be in a file name). Plural/singular is folded per word ("Noodles").
const norm = (s: string) => s.toLowerCase()
  .replace(/\((uber|t|\d+\s*g[^)]*|\d+\s*(pcs?|pieces?))\)/g, ' ')
  .replace(/\bw\s*[_/]\s*/g, 'with ').replace(/_/g, ' ').replace(/&/g, ' and ')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ')
const noPack = (s: string) => norm(s).replace(/\b\d+(\s*-\s*\d+)?\s*(pcs|pc|pieces|piece|oz)\b/g, ' ').replace(/\b(x\s*)?\d+\s*$/g, ' ').replace(/\s+/g, ' ').trim()

type Photo = { file: string; path: string; n: string; p: string }
function photosFor(key: string): Photo[] {
  const d = join(DIR, 'photos', key)
  if (!existsSync(d)) return []
  return readdirSync(d).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).map(f => {
    const base = f.slice(0, -extname(f).length)
    return { file: f, path: join(d, f), n: norm(base), p: noPack(base) }
  })
}

function matchPhoto(item: string, photos: Photo[]): { photo: Photo; how: 'exact' | 'pack-size' } | null {
  const n = norm(item), p = noPack(item)
  const exact = photos.find(x => x.n === n)
  if (exact) return { photo: exact, how: 'exact' }
  const hits = photos.filter(x => x.p === p && p.length >= 4)
  if (hits.length) {
    // Prefer the largest pack shot when several sizes exist (e.g. 1Pc vs 5Pc).
    hits.sort((a, b) => Number((b.file.match(/(\d+)\s*pc/i) || [0, 0])[1]) - Number((a.file.match(/(\d+)\s*pc/i) || [0, 0])[1]))
    return { photo: hits[0], how: 'pack-size' }
  }
  return null
}

function contentType(file: string): string {
  const e = extname(file).toLowerCase()
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg'
}
const uploaded = new Map<string, string>()
async function upload(path: string): Promise<string> {
  const buf = readFileSync(path)
  const sha = createHash('sha256').update(buf).digest('hex')
  if (uploaded.has(sha)) return uploaded.get(sha)!
  const ext = extname(path).slice(1).toLowerCase().replace('jpeg', 'jpg')
  const blob = await put(`menu-item-images/${sha}.${ext}`, buf, { access: 'public', contentType: contentType(path), allowOverwrite: true })
  uploaded.set(sha, blob.url)
  return blob.url
}

/** Ordering window per day from the store hours: one window (the menu schedule holds one), earliest open → latest close that day. */
function scheduleFrom(hours: StoreHours | null) {
  const perDay: Record<string, { from: string; to: string }> = {}; const notes: string[] = []
  for (const d of STORE_DAYS) {
    const w = hours?.[d] || []
    if (!w.length) continue
    const from = w.map(x => x.open).sort()[0]
    const closes = w.map(x => (x.close < x.open ? '23:45' : x.close))
    if (w.some(x => x.close < x.open)) notes.push(`${d}: closes after midnight → ordering window ends 11:45 PM`)
    if (w.length > 1) notes.push(`${d}: split hours → one window ${from}–${closes.sort().slice(-1)[0]}`)
    perDay[d] = { from, to: closes.sort().slice(-1)[0] }
  }
  return { cfg: { scheduleType: 'CUSTOM', days: Object.keys(perDay), perDay, sameWindow: perDay[Object.keys(perDay)[0]] || { from: '11:00', to: '19:00' } }, notes }
}

export async function menus(apply: boolean, argv: string[]) {
  await runDiscoMenuMigrations()
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
  const locs = JSON.parse(readFileSync(join(DIR, 'locations.json'), 'utf8')) as Array<{ key: string; store: string }>
  const report: Record<string, unknown> = {}
  for (const loc of locs as Array<{ key: string; store: string }>) {
    if (only && loc.key !== only) continue
    if (NO_MENU.has(loc.key)) { report[loc.key] = { skipped: 'no menu for Atlanta (Peter)' }; continue }
    if (!existsSync(join(DIR, 'menus', `${loc.key}.csv`))) { report[loc.key] = { skipped: 'no catering menu link in the sheet' }; continue }
    const [r] = (await sql`
      SELECT c.restaurant_reference ref FROM disco_restaurant_cache c
       WHERE c.name = ${loc.store} AND c.is_disco_native = true ORDER BY c.cached_at DESC LIMIT 2`) as Array<{ ref: string }>
    if (!r) throw new Error('location not found: ' + loc.store)
    const items = loadItems(loc.key)
    const photos = photosFor(loc.key)
    const used = new Set<string>()
    const plan = items.map(it => { const m = matchPhoto(it.name, photos); if (m) used.add(m.photo.file); return { ...it, photo: m } })
    const { cfg, notes } = scheduleFrom(hoursFromSheet(loc as unknown as Record<string, string>))
    const noPrice = plan.filter(p => p.price == null).map(p => p.name)
    const choose = plan.filter(p => /\bchoose\b/i.test(p.description)).map(p => p.name)
    report[loc.key] = {
      store: loc.store, items: plan.length, categories: [...new Set(plan.map(p => p.category))].length,
      images: plan.filter(p => p.photo).length,
      imagesByPackSize: plan.filter(p => p.photo?.how === 'pack-size').map(p => `${p.name} ← ${p.photo!.photo.file}`),
      itemsWithoutImage: plan.filter(p => !p.photo).map(p => p.name),
      unusedImages: photos.filter(p => !used.has(p.file)).map(p => p.file),
      noPrice, needsOptions: choose, scheduleNotes: notes,
    }
    if (!apply) continue
    const exists = (await sql`SELECT 1 FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND name = ${MENU_NAME} LIMIT 1`) as unknown[]
    if (exists.length) { (report[loc.key] as Record<string, unknown>).built = 'already exists — skipped'; continue }
    let url = 'catering-menu'
    for (let i = 2; ((await sql`SELECT 1 FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND url = ${url}`) as unknown[]).length; i++) url = `catering-menu-${i}`
    const [m] = (await sql`
      INSERT INTO disco_menus (
        restaurant_reference, name, url, type, visible, availability_mode, schedule_config,
        offers_pickup, offers_delivery, service_charge_pct, tip_default_type, tip_default_value,
        pickup_order_minimum, delivery_order_minimum, lead_time_hours, rolling_availability_days,
        delivery_settings, include_utensils, position, created_at, updated_at
      ) VALUES (
        ${r.ref}::uuid, ${MENU_NAME}, ${url}, 'GENERAL_CATERING', true, 'ALWAYS', ${JSON.stringify(cfg)}::jsonb,
        true, true, 0, 'PERCENTAGE', 15,
        0, 0, 48, 90,
        ${JSON.stringify({ own: {}, method: 'THIRD_PARTY', thirdPartySubsidyPct: 0 })}::jsonb, false,
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid), NOW(), NOW()
      ) RETURNING reference`) as Array<{ reference: string }>
    const catRefs = new Map<string, string>()
    for (const c of [...new Set(plan.map(p => p.category))]) {
      const [cat] = (await sql`
        INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, position, visible)
        VALUES (${r.ref}::uuid, ${m.reference}::uuid, ${c}, ${catRefs.size}, true) RETURNING reference`) as Array<{ reference: string }>
      catRefs.set(c, cat.reference)
    }
    const pos = new Map<string, number>()
    for (const it of plan) {
      if (it.price == null) continue
      const image = it.photo ? await upload(it.photo.photo.path) : null
      const p = pos.get(it.category) || 0; pos.set(it.category, p + 1)
      await sql`
        INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, visible, position, image_url, allow_special_instructions)
        VALUES (${r.ref}::uuid, ${catRefs.get(it.category)}::uuid, ${it.name}, ${it.description || null}, ${it.price}, ${it.serves}, true, ${p}, ${image}, true)`
    }
    ;(report[loc.key] as Record<string, unknown>).built = m.reference
    console.log(`built ${loc.store}: ${plan.length} items`)
  }
  writeFileSync(join(DIR, apply ? 'menus-report.json' : 'menus-plan.json'), JSON.stringify(report, null, 1))
  for (const [k, v] of Object.entries(report)) {
    const x = v as Record<string, unknown>
    console.log(`${k}: ${x.skipped ?? `${x.items} items, ${x.images} with image, ${(x.itemsWithoutImage as string[]).length} without, ${(x.unusedImages as string[]).length} unused images, noPrice ${(x.noPrice as string[]).length}, needsOptions ${(x.needsOptions as string[]).length}`}`)
  }
}

// ── OPTION GROUPS (Peter, 23 Oct 2026) ───────────────────────────────────────
// Each Catering Menu sheet's second tab, "Option Group", lists every item's
// choices: one row per choice with the item's Product ID, the group name, its
// add-on price, Required, Minimum/Maximum Selection, whether the same choice may
// repeat, and an instruction. option-plan.json is that tab, parsed and checked
// (rows of one group agree on required/min/max; Product IDs map to items via the
// Item tab). Each group becomes a modifier group on the item already built —
// nothing else on the menu changes.
type PlanGroup = { item: string; group: string; required: boolean; min: number; max: number; repeats: boolean; instruction: string; options: Array<{ name: string; price: number }> }

export async function options(apply: boolean, argv: string[]) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
  const plan = JSON.parse(readFileSync(join(DIR, 'option-plan.json'), 'utf8')) as Record<string, PlanGroup[]>
  const locs = JSON.parse(readFileSync(join(DIR, 'locations.json'), 'utf8')) as Array<{ key: string; store: string }>
  const report: Record<string, unknown> = {}
  for (const loc of locs as Array<{ key: string; store: string }>) {
    if (only && loc.key !== only) continue
    const groups = plan[loc.key]
    if (!groups?.length) continue
    const [r] = (await sql`
      SELECT c.restaurant_reference ref FROM disco_restaurant_cache c
       WHERE c.name = ${loc.store} AND c.is_disco_native = true LIMIT 1`) as Array<{ ref: string }>
    const items = (await sql`
      SELECT i.reference, i.name, (SELECT count(*) FROM disco_item_groups ig WHERE ig.item_reference = i.reference)::int AS groups
        FROM disco_menu_items i JOIN disco_menu_categories c ON c.reference = i.category_reference
        JOIN disco_menus m ON m.reference = c.menu_reference
       WHERE m.restaurant_reference = ${r.ref}::uuid AND m.name = ${MENU_NAME}`) as Array<{ reference: string; name: string; groups: number }>
    const byName = new Map(items.map(i => [i.name, i]))
    const added: string[] = []; const problems: string[] = []
    const posByItem = new Map<string, number>()
    for (const g of groups) {
      const it = byName.get(g.item)
      if (!it) { problems.push(`no built item named "${g.item}"`); continue }
      if (it.groups > 0 && !posByItem.has(it.reference)) { problems.push(`"${g.item}" already has option groups — skipped`); continue }
      // A choice listed twice in one group is kept once (the sheet repeats it).
      const seen = new Set<string>(); const opts = g.options.filter(o => !seen.has(o.name + '|' + o.price) && seen.add(o.name + '|' + o.price))
      if (opts.length < g.options.length) problems.push(`${g.item} / ${g.group}: duplicate choice listed in the sheet, kept once`)
      const label = `${g.item} — ${g.group}: ${g.required ? 'required' : 'optional'}, ${g.min === g.max ? `exactly ${g.min}` : `${g.min}–${g.max}`}${g.repeats ? ', repeats allowed' : ''}; ${opts.length} choices${opts.some(o => o.price) ? ` (${opts.filter(o => o.price).length} add a price)` : ''}`
      added.push(label)
      if (!apply) { posByItem.set(it.reference, (posByItem.get(it.reference) || 0) + 1); continue }
      const pos = posByItem.get(it.reference) || 0
      posByItem.set(it.reference, pos + 1)
      const [grp] = (await sql`
        INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, visible, position)
        VALUES (${r.ref}::uuid, ${`${g.item} - ${g.group}`}, ${g.group}, ${g.instruction || (g.required ? 'Required' : 'Optional')},
                ${g.required ? Math.max(1, g.min) : g.min}, ${Math.max(g.max, g.required ? Math.max(1, g.min) : 1)}, true, ${pos})
        RETURNING reference`) as Array<{ reference: string }>
      for (const [i, o] of opts.entries()) {
        const [mod] = (await sql`
          INSERT INTO disco_modifiers (restaurant_reference, name, price, visible, position)
          VALUES (${r.ref}::uuid, ${o.name}, ${o.price}, true, ${i}) RETURNING reference`) as Array<{ reference: string }>
        await sql`INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position) VALUES (${grp.reference}::uuid, ${mod.reference}::uuid, ${i})`
      }
      await sql`INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position) VALUES (${it.reference}::uuid, ${grp.reference}::uuid, true, ${pos})`
    }
    // Items whose own wording says "Choose …" but the tab gives no choices.
    const withGroups = new Set(groups.map(g => g.item))
    const desc = (await sql`
      SELECT i.name, i.description FROM disco_menu_items i JOIN disco_menu_categories c ON c.reference = i.category_reference
        JOIN disco_menus m ON m.reference = c.menu_reference WHERE m.restaurant_reference = ${r.ref}::uuid AND m.name = ${MENU_NAME}`) as Array<{ name: string; description: string | null }>
    const stillNoChoices = desc.filter(d => /\bchoose\b/i.test(d.description || '') && !withGroups.has(d.name)).map(d => d.name)
    report[loc.key] = { store: loc.store, added, problems, stillNoChoices }
  }
  writeFileSync(join(DIR, apply ? 'options-report.json' : 'options-dryrun.json'), JSON.stringify(report, null, 1))
  for (const [k, v] of Object.entries(report)) {
    const x = v as { added: string[]; problems: string[]; stillNoChoices: string[] }
    console.log(`${k}: ${x.added.length} groups${x.problems.length ? ' | ' + x.problems.join('; ') : ''}${x.stillNoChoices.length ? ' | says "choose" but no choices in the tab: ' + x.stillNoChoices.join(', ') : ''}`)
  }
}

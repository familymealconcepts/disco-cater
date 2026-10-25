// The Menu Builder's menu shape. Claude only ever returns one of these (JSON,
// validated against MENU_SPEC_SCHEMA by the API's structured output); the
// writer (lib/menu-builder/writer.ts) is the only thing that turns it into
// rows. Every field maps to an existing disco_menus / categories / items /
// modifier-group column; nothing here adds to the data model.

import { sql } from '../db'

export const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
export const MENU_TYPES = ['GENERAL_CATERING', 'OFFICE_CATERING', 'HOLIDAY_CATERING', 'MEAL_PREP', 'PRIVATE_CHEF', 'NATIONWIDE_SHIPPING', 'MERCH', 'POP_UP'] as const

export type SpecOption = { name: string; price: number }
export type SpecGroup = {
  ref: string | null
  name: string            // internal name (restaurant portal)
  title: string           // what customers see, e.g. "Select Size"
  subtitle: string | null // e.g. "Required" or an instruction
  min: number
  max: number
  options: SpecOption[]
}
export type SpecItem = {
  ref: string | null
  name: string
  description: string | null
  price: number
  display_price: string | null
  serves: string | null
  min_quantity: number | null
  image: string | null    // an uploaded photo's file name, or the existing image URL on an update
  vegetarian: boolean
  vegan: boolean
  gluten_free: boolean
  dairy_free: boolean
  contains_nuts: boolean
  option_groups: SpecGroup[]
}
export type SpecCategory = { ref: string | null; name: string; description: string | null; items: SpecItem[] }
export type SpecSettings = {
  availability_mode: 'ALWAYS' | 'CUSTOM'
  start_date: string | null
  end_date: string | null
  windows: { day: typeof DAYS[number]; from: string; to: string }[]
  offers_pickup: boolean
  offers_delivery: boolean
  lead_time_hours: number
  hard_cutoff_date: string | null
  hard_cutoff_time: string | null
  tip_default_type: 'PERCENTAGE' | 'CUSTOM' | 'NONE'
  tip_default_value: number
  service_charge_pct: number
  pickup_order_minimum: number
  delivery_order_minimum: number
  max_orders_per_day: number | null
  rolling_availability_days: number
  include_utensils: boolean
}
export type MenuSpec = {
  name: string
  type: typeof MENU_TYPES[number]
  description: string | null
  settings: SpecSettings
  categories: SpecCategory[]
}

// ── JSON schema for structured output ───────────────────────────────────────
// The API allows at most 16 nullable fields in a schema, so the model writes
// "" for empty text and 0 for "no minimum quantity" / "no daily order limit";
// normalizeSpec turns those back into NULL.
const S = (type: string | string[], extra: Record<string, unknown> = {}) => ({ type, ...extra })
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const GROUP_SCHEMA = obj({
  ref: S('string'), name: S('string'), title: S('string'), subtitle: S('string'),
  min: S('integer'), max: S('integer'),
  options: { type: 'array', items: obj({ name: S('string'), price: S('number') }) },
})
const ITEM_SCHEMA = obj({
  ref: S('string'), name: S('string'), description: S('string'),
  price: S('number'), display_price: S('string'), serves: S('string'),
  min_quantity: S('integer'), image: S('string'),
  vegetarian: S('boolean'), vegan: S('boolean'), gluten_free: S('boolean'), dairy_free: S('boolean'), contains_nuts: S('boolean'),
  option_groups: { type: 'array', items: GROUP_SCHEMA },
})
export const MENU_SPEC_SCHEMA = obj({
  name: S('string'),
  type: { type: 'string', enum: [...MENU_TYPES] },
  description: S('string'),
  settings: obj({
    availability_mode: { type: 'string', enum: ['ALWAYS', 'CUSTOM'] },
    start_date: S('string'), end_date: S('string'),
    windows: { type: 'array', items: obj({ day: { type: 'string', enum: [...DAYS] }, from: S('string'), to: S('string') }) },
    offers_pickup: S('boolean'), offers_delivery: S('boolean'),
    lead_time_hours: S('integer'),
    hard_cutoff_date: S('string'), hard_cutoff_time: S('string'),
    tip_default_type: { type: 'string', enum: ['PERCENTAGE', 'CUSTOM', 'NONE'] },
    tip_default_value: S('number'), service_charge_pct: S('number'),
    pickup_order_minimum: S('number'), delivery_order_minimum: S('number'),
    max_orders_per_day: S('integer'), rolling_availability_days: S('integer'),
    include_utensils: S('boolean'),
  }),
  categories: { type: 'array', items: obj({ ref: S('string'), name: S('string'), description: S('string'), items: { type: 'array', items: ITEM_SCHEMA } }) },
})

// ── Normalising what the model returns ──────────────────────────────────────
const money2 = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 100) / 100 : NaN }
const hhmm = (v: unknown): string | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}
const isoDate = (v: unknown): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null)
const fmtMoney = (n: number) => `$${n.toFixed(2)}`

/**
 * Clean a spec and apply the one rule the writer enforces itself rather than
 * trusting the model: a priced-at-0 item with a required group whose options
 * are all priced shows "from" the cheapest option. Returns problems that would
 * make the menu wrong (non-finite or negative prices) instead of writing them.
 */
export function normalizeSpec(raw: MenuSpec): { spec: MenuSpec; problems: string[] } {
  const problems: string[] = []
  const s = raw.settings
  const settings: SpecSettings = {
    availability_mode: s.availability_mode === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS',
    start_date: isoDate(s.start_date), end_date: isoDate(s.end_date),
    windows: (s.windows || []).filter(w => DAYS.includes(w.day) && hhmm(w.from) && hhmm(w.to))
      .map(w => ({ day: w.day, from: hhmm(w.from)!, to: hhmm(w.to)! })),
    offers_pickup: s.offers_pickup !== false,
    offers_delivery: s.offers_delivery === true,
    lead_time_hours: Math.max(0, Math.min(24 * 90, Math.trunc(Number(s.lead_time_hours) || 0))),
    hard_cutoff_date: isoDate(s.hard_cutoff_date),
    hard_cutoff_time: isoDate(s.hard_cutoff_date) ? hhmm(s.hard_cutoff_time) : null,
    tip_default_type: (['PERCENTAGE', 'CUSTOM', 'NONE'] as const).includes(s.tip_default_type) ? s.tip_default_type : 'PERCENTAGE',
    tip_default_value: Math.max(0, money2(s.tip_default_value) || 0),
    service_charge_pct: Math.max(0, money2(s.service_charge_pct) || 0),
    pickup_order_minimum: Math.max(0, money2(s.pickup_order_minimum) || 0),
    delivery_order_minimum: Math.max(0, money2(s.delivery_order_minimum) || 0),
    max_orders_per_day: Math.trunc(Number(s.max_orders_per_day)) > 0 ? Math.trunc(Number(s.max_orders_per_day)) : null,
    rolling_availability_days: Math.max(1, Math.min(365, Math.trunc(Number(s.rolling_availability_days)) || 90)),
    include_utensils: s.include_utensils === true,
  }
  if (settings.availability_mode === 'CUSTOM' && (!settings.start_date || !settings.end_date)) problems.push('Custom availability needs a start and end date.')
  const seenCats = new Set<string>()
  const categories: SpecCategory[] = (raw.categories || []).map(c => {
    let name = String(c.name || '').trim() || 'Menu'
    // disco_menu_categories is unique on (menu, name)
    for (let i = 2; seenCats.has(name.toLowerCase()); i++) name = `${String(c.name).trim()} (${i})`
    seenCats.add(name.toLowerCase())
    return {
      ref: c.ref || null, name, description: c.description?.trim() || null,
      items: (c.items || []).map(it => {
        const price = money2(it.price)
        if (!Number.isFinite(price) || price < 0) problems.push(`"${it.name}" has an invalid price (${it.price}).`)
        const groups: SpecGroup[] = (it.option_groups || []).map(g => {
          const options = (g.options || []).map(o => {
            const p = money2(o.price)
            if (!Number.isFinite(p) || p < 0) problems.push(`"${it.name}" → "${g.title}" → "${o.name}" has an invalid price (${o.price}).`)
            return { name: String(o.name).trim(), price: Number.isFinite(p) ? p : 0 }
          }).filter(o => o.name)
          const min = Math.max(0, Math.trunc(Number(g.min)) || 0)
          const max = Math.max(min, Math.max(1, Math.trunc(Number(g.max)) || 1))
          return { ref: g.ref || null, name: String(g.name || g.title).trim(), title: String(g.title || g.name).trim(), subtitle: g.subtitle?.trim() || null, min, max: Math.min(max, Math.max(1, options.length)), options }
        }).filter(g => g.options.length)
        let display = it.display_price?.trim() || null
        const req = groups.find(g => g.min >= 1 && g.options.every(o => o.price > 0))
        if ((Number.isFinite(price) ? price : 0) === 0 && req && !display) display = `${fmtMoney(Math.min(...req.options.map(o => o.price)))}+`
        return {
          ref: it.ref || null, name: String(it.name).trim(), description: it.description?.trim() || null,
          price: Number.isFinite(price) ? Math.max(0, price) : 0, display_price: display, serves: it.serves?.trim() || null,
          min_quantity: Math.trunc(Number(it.min_quantity)) > 0 ? Math.trunc(Number(it.min_quantity)) : null,
          image: it.image?.trim() || null,
          vegetarian: !!it.vegetarian, vegan: !!it.vegan, gluten_free: !!it.gluten_free, dairy_free: !!it.dairy_free, contains_nuts: !!it.contains_nuts,
          option_groups: groups,
        }
      }).filter(it => it.name),
    }
  })
  return { spec: { name: String(raw.name || '').trim() || 'New Menu', type: MENU_TYPES.includes(raw.type) ? raw.type : 'GENERAL_CATERING', description: raw.description?.trim() || null, settings, categories }, problems }
}

// ── Reading a menu out of Neon into the same shape ──────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SSE event / SQL row
type Row = Record<string, any>

export async function readMenuSpec(menuRef: string): Promise<{ restaurantRef: string; visible: boolean; archived: boolean; spec: MenuSpec } | null> {
  const ms = (await sql`SELECT * FROM disco_menus WHERE reference = ${menuRef}::uuid`) as Row[]
  const m = ms[0]
  if (!m) return null
  const cats = (await sql`SELECT reference, name, description FROM disco_menu_categories WHERE menu_reference = ${menuRef}::uuid ORDER BY position, id`) as Row[]
  const items = cats.length ? (await sql`
    SELECT i.* FROM disco_menu_items i WHERE i.category_reference = ANY(${cats.map(c => c.reference)}::uuid[]) ORDER BY i.position, i.id`) as Row[] : []
  const links = items.length ? (await sql`
    SELECT ig.item_reference, ig.position AS link_pos, g.reference, g.name, g.external_name, g.sub_external_name, g.min_selected, g.max_selected
      FROM disco_item_groups ig JOIN disco_modifier_groups g ON g.reference = ig.group_reference
     WHERE ig.item_reference = ANY(${items.map(i => i.reference)}::uuid[]) AND ig.enabled = true AND g.archived = false
     ORDER BY ig.position, ig.id`) as Row[] : []
  const groupRefs = [...new Set(links.map(l => l.reference))]
  const mods = groupRefs.length ? (await sql`
    SELECT gm.group_reference, md.name, md.price FROM disco_modifier_group_members gm
      JOIN disco_modifiers md ON md.reference = gm.modifier_reference
     WHERE gm.group_reference = ANY(${groupRefs}::uuid[]) AND md.archived = false
     ORDER BY gm.position, gm.id`) as Row[] : []
  const optsByGroup = new Map<string, SpecOption[]>()
  for (const md of mods) {
    const a = optsByGroup.get(md.group_reference) || []
    a.push({ name: md.name, price: Number(md.price) })
    optsByGroup.set(md.group_reference, a)
  }
  const sc = (m.schedule_config || {}) as Row
  const days: string[] = Array.isArray(sc.days) ? sc.days : []
  const windows = days.filter((d): d is typeof DAYS[number] => (DAYS as readonly string[]).includes(d)).map(d => {
    const w = sc.scheduleType === 'CUSTOM' ? (sc.perDay?.[d] || sc.sameWindow) : (sc.sameWindow || sc.perDay?.[d])
    return { day: d, from: hhmm(w?.from) || '00:00', to: hhmm(w?.to) || '23:59' }
  })
  const d = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null)
  const spec: MenuSpec = {
    name: m.name, type: m.type, description: m.description ?? null,
    settings: {
      availability_mode: m.availability_mode === 'CUSTOM' ? 'CUSTOM' : 'ALWAYS',
      start_date: d(m.start_date), end_date: d(m.end_date), windows,
      offers_pickup: m.offers_pickup !== false, offers_delivery: m.offers_delivery !== false,
      lead_time_hours: Number(m.lead_time_hours ?? 0),
      hard_cutoff_date: d(m.hard_cutoff_date), hard_cutoff_time: m.hard_cutoff_time ? String(m.hard_cutoff_time).slice(0, 5) : null,
      tip_default_type: m.tip_default_type, tip_default_value: Number(m.tip_default_value ?? 0),
      service_charge_pct: Number(m.service_charge_pct ?? 0),
      pickup_order_minimum: Number(m.pickup_order_minimum ?? 0), delivery_order_minimum: Number(m.delivery_order_minimum ?? 0),
      max_orders_per_day: m.max_orders_per_day == null ? null : Number(m.max_orders_per_day),
      rolling_availability_days: Number(m.rolling_availability_days ?? 90),
      include_utensils: m.include_utensils === true,
    },
    categories: cats.map(c => ({
      ref: c.reference, name: c.name, description: c.description ?? null,
      items: items.filter(i => i.category_reference === c.reference).map(i => ({
        ref: i.reference, name: i.name, description: i.description ?? null, price: Number(i.price ?? 0),
        display_price: i.display_price ?? null, serves: i.serves ?? null, min_quantity: i.min_quantity ?? null,
        image: i.image_url ?? null,
        vegetarian: !!i.vegetarian, vegan: !!i.vegan, gluten_free: !!i.gluten_free, dairy_free: !!i.dairy_free, contains_nuts: !!i.contains_nuts,
        option_groups: links.filter(l => l.item_reference === i.reference).map(l => ({
          ref: l.reference, name: l.name, title: l.external_name || l.name, subtitle: l.sub_external_name ?? null,
          min: Number(l.min_selected ?? 0), max: Number(l.max_selected ?? 1), options: optsByGroup.get(l.reference) || [],
        })),
      })),
    })),
  }
  return { restaurantRef: m.restaurant_reference, visible: !!m.visible, archived: !!m.archived, spec }
}

/**
 * What a location's menu IS, without anything location-specific (references,
 * internal group names, which differ per location by design). Two locations
 * whose fingerprints match have the same menu.
 */
export function fingerprint(spec: MenuSpec): string {
  const strip = (s: MenuSpec) => ({
    name: s.name, type: s.type, description: s.description, settings: s.settings,
    categories: s.categories.map(c => ({
      name: c.name, description: c.description,
      items: c.items.map(i => ({
        name: i.name, description: i.description, price: i.price, display_price: i.display_price, serves: i.serves,
        min_quantity: i.min_quantity, image: i.image, vegetarian: i.vegetarian, vegan: i.vegan, gluten_free: i.gluten_free,
        dairy_free: i.dairy_free, contains_nuts: i.contains_nuts,
        option_groups: i.option_groups.map(g => ({ title: g.title, subtitle: g.subtitle, min: g.min, max: g.max, options: g.options })),
      })),
    })),
  })
  return JSON.stringify(strip(spec))
}

/** A compact, readable rendering of a menu for the bot's context. */
export function specToText(spec: MenuSpec, opts: { refs?: boolean } = {}): string {
  const s = spec.settings
  const L: string[] = []
  L.push(`MENU "${spec.name}" (${spec.type})${spec.description ? ` — ${spec.description}` : ''}`)
  L.push(`  settings: availability ${s.availability_mode}${s.start_date ? ` ${s.start_date}→${s.end_date}` : ''}; windows ${s.windows.map(w => `${w.day.slice(0, 3)} ${w.from}-${w.to}`).join(', ') || 'none'}; pickup ${s.offers_pickup}, delivery ${s.offers_delivery}; lead ${s.lead_time_hours}h; hard cutoff ${s.hard_cutoff_date ?? '—'} ${s.hard_cutoff_time ?? ''}; tip ${s.tip_default_type} ${s.tip_default_value}; service charge ${s.service_charge_pct}%; minimums pickup $${s.pickup_order_minimum} / delivery $${s.delivery_order_minimum}; utensils ${s.include_utensils}`)
  for (const c of spec.categories) {
    L.push(`  CATEGORY "${c.name}"${opts.refs && c.ref ? ` [ref ${c.ref}]` : ''}${c.description ? ` — ${c.description}` : ''}`)
    for (const i of c.items) {
      const flags = [i.vegetarian && 'V', i.vegan && 'VG', i.gluten_free && 'GF', i.dairy_free && 'DF', i.contains_nuts && 'nuts'].filter(Boolean).join(',')
      L.push(`    • ${i.name}${opts.refs && i.ref ? ` [ref ${i.ref}]` : ''} — $${i.price.toFixed(2)}${i.display_price ? ` (card shows ${i.display_price})` : ''}${i.serves ? `, serves ${i.serves}` : ''}${i.min_quantity ? `, min qty ${i.min_quantity}` : ''}${flags ? ` [${flags}]` : ''}${i.image ? ' [has photo]' : ''}${i.description ? ` — ${i.description}` : ''}`)
      for (const g of i.option_groups) {
        L.push(`        ◦ group "${g.title}"${g.subtitle ? ` (${g.subtitle})` : ''}${opts.refs && g.ref ? ` [ref ${g.ref}]` : ''} min ${g.min} max ${g.max}: ${g.options.map(o => `${o.name} $${o.price.toFixed(2)}`).join('; ')}`)
      }
    }
  }
  return L.join('\n')
}

// ── Before → after ───────────────────────────────────────────────────────────
export type Change = { where: string; field: string; before: string; after: string }

const show = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'number' ? String(v) : String(v))
const groupLine = (g: SpecGroup) => `${g.title} (min ${g.min}, max ${g.max}): ${g.options.map(o => `${o.name} ${fmtMoney(o.price)}`).join(', ')}`

/**
 * Every difference between the live menu (`before`, read with refs) and the
 * bot's proposal (`after`), item by item. Matching is by ref first (the bot
 * keeps the refs it was given), then by name.
 */
export function diffSpecs(before: MenuSpec, after: MenuSpec): Change[] {
  const out: Change[] = []
  const add = (where: string, field: string, b: unknown, a: unknown) => { if (show(b) !== show(a)) out.push({ where, field, before: show(b), after: show(a) }) }
  add('Menu', 'name', before.name, after.name)
  add('Menu', 'type', before.type, after.type)
  add('Menu', 'description', before.description, after.description)
  for (const k of Object.keys(after.settings) as (keyof SpecSettings)[]) {
    const b = k === 'windows' ? before.settings.windows.map(w => `${w.day} ${w.from}-${w.to}`).join(', ') : before.settings[k]
    const a = k === 'windows' ? after.settings.windows.map(w => `${w.day} ${w.from}-${w.to}`).join(', ') : after.settings[k]
    add('Menu settings', k, b, a)
  }
  const bItems = new Map<string, { cat: SpecCategory; item: SpecItem }>()
  for (const c of before.categories) for (const i of c.items) bItems.set(i.ref || `${c.name}::${i.name}`, { cat: c, item: i })
  const seen = new Set<string>()
  const bCats = new Map(before.categories.map(c => [c.ref || c.name, c]))
  for (const c of after.categories) {
    const bc = (c.ref && bCats.get(c.ref)) || before.categories.find(x => x.name === c.name)
    if (!bc) out.push({ where: `Category "${c.name}"`, field: 'category', before: '—', after: `new (${c.items.length} items)` })
    else {
      add(`Category "${bc.name}"`, 'name', bc.name, c.name)
      add(`Category "${c.name}"`, 'description', bc.description, c.description)
    }
    for (const i of c.items) {
      const key = i.ref && bItems.has(i.ref) && !seen.has(i.ref) ? i.ref : [...bItems.entries()].find(([k, v]) => v.item.name === i.name && !seen.has(k))?.[0]
      const b = key ? bItems.get(key) : undefined
      if (!b) { out.push({ where: `"${i.name}"`, field: 'item', before: '—', after: `new in "${c.name}" at ${fmtMoney(i.price)}${i.display_price ? ` (${i.display_price})` : ''}${i.option_groups.length ? `; ${i.option_groups.map(groupLine).join(' | ')}` : ''}` }); continue }
      seen.add(key!)
      const w = `"${b.item.name}"`
      if (b.cat.name !== c.name) add(w, 'category', b.cat.name, c.name)
      add(w, 'name', b.item.name, i.name)
      add(w, 'description', b.item.description, i.description)
      add(w, 'price', fmtMoney(b.item.price), fmtMoney(i.price))
      add(w, 'card price', b.item.display_price, i.display_price)
      add(w, 'serves', b.item.serves, i.serves)
      add(w, 'min quantity', b.item.min_quantity, i.min_quantity)
      add(w, 'photo', b.item.image ? 'yes' : '—', i.image ? (i.image === b.item.image ? 'yes' : `new: ${i.image}`) : '—')
      for (const f of ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'contains_nuts'] as const) add(w, f, b.item[f] ? 'yes' : 'no', i[f] ? 'yes' : 'no')
      // Groups: option-level detail, so "raise half trays $5" reads as Half tray $60.00 → $65.00.
      const bg = b.item.option_groups, ag = i.option_groups
      for (const g of ag) {
        const og = (g.ref && bg.find(x => x.ref === g.ref)) || bg.find(x => x.title === g.title)
        if (!og) { out.push({ where: w, field: `option group "${g.title}"`, before: '—', after: groupLine(g) }); continue }
        add(w, `"${g.title}" rules`, `min ${og.min}, max ${og.max}${og.subtitle ? `, ${og.subtitle}` : ''}`, `min ${g.min}, max ${g.max}${g.subtitle ? `, ${g.subtitle}` : ''}`)
        if (og.title !== g.title) add(w, 'option group title', og.title, g.title)
        for (const o of g.options) {
          const oo = og.options.find(x => x.name === o.name)
          add(w, `${g.title} → ${o.name}`, oo ? fmtMoney(oo.price) : '—', fmtMoney(o.price))
        }
        for (const oo of og.options) if (!g.options.find(x => x.name === oo.name)) add(w, `${g.title} → ${oo.name}`, fmtMoney(oo.price), '—')
      }
      for (const og of bg) if (!ag.find(g => (g.ref && g.ref === og.ref) || g.title === og.title)) out.push({ where: w, field: `option group "${og.title}"`, before: groupLine(og), after: 'removed' })
    }
  }
  for (const [k, v] of bItems) if (!seen.has(k)) out.push({ where: `"${v.item.name}"`, field: 'item', before: `in "${v.cat.name}"`, after: 'removed' })
  for (const bc of before.categories) if (!after.categories.find(c => (c.ref && c.ref === bc.ref) || c.name === bc.name)) out.push({ where: `Category "${bc.name}"`, field: 'category', before: `${bc.items.length} items`, after: 'removed' })
  return out
}

/**
 * Chubby Group onboarding (Peter, 23 Oct 2026). Source: "Copy of Chubby Group
 * Onboarding Tracker" — extracted WITHOUT any banking/tax columns into
 * locations.json, plus each location's catering-menu CSV and photo ZIP.
 *
 *   npx tsx scripts/chubby-onboarding-2026-10.ts locations [--apply]
 *   npx tsx scripts/chubby-onboarding-2026-10.ts menus [--apply] [--only <key>]
 *
 * Every location stays HIDDEN (map off, online ordering off) and gets no Stripe
 * account. Dry run by default; Neon HTTP has no transactions, so each step is
 * idempotent and re-runnable.
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { sql, runMigrations } from '../lib/db'
import { saveRestaurantAddress } from '../lib/restaurant-address'
import { parseDayHours, STORE_DAYS, type StoreHours } from '../lib/store-hours'
import { applyListChange, currentList } from '../lib/system-admin-authority'
import { ensureLocationGroups } from '../lib/location-groups'
import { logAdminAction } from '../lib/admin-audit'

const DIR = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/32d3e220-b54a-4eef-b0a3-fc6cbc411db4/scratchpad/chubby'
const APPLY = process.argv.includes('--apply')
const ACTOR = 'claude-for-peter (chubby onboarding 2026-10-23)'
const RYAN = 'ryan.luo@chubbygroup.com'
const GROUP = 'disco-chubby-group'

type Row = {
  id: string; store: string; brand: string; address: string; address2: string; city: string; state: string; zip: string
  phone: string; website: string; key: string; catering_id: string | null; photo_id: string | null
  sun: string; mon: string; tue: string; wed: string; thu: string; fri: string; sat: string
}

// The ten that already exist in Disco — matched by name AND street/ZIP on
// 23 Oct 2026 (all Disco-native, no menus, no orders). Pinned by reference so
// a re-run can never create a second copy.
const EXISTING: Record<string, string> = {
  'chubby-bowls-new-york': '65f3d153-2c24-46eb-8d7f-4e4e896ac7b6',
  'chubby-cattle-monterey-park': '2f56b77e-7508-4015-be32-fc008ae8ebb8',
  'chubby-mart-rowland-heights': 'f2511817-4ed2-471a-b9d2-30cabad4f1c8',
  'chubby-nori-new-york': '577c601b-a746-494b-80d2-25c5491d86ec',
  'chubby-skewers-mesa': '737be093-f2c5-4e4f-8707-bc50f529a0be',
  'chubby-tan-new-york': '116027fa-7c9b-4812-a253-e055810602b6',
  'mama-xita-bbq-temple-city': '307b512c-0d15-43e8-9b95-498753fe6f95',
  'mr-chubby-rowland-heights': '4e832011-7ca2-4f4d-a2de-c7e1201e20d5',
  'niku-x-new-york': '6ff32968-b9b5-4f6f-9902-15b9efcb1bb5',
  'wagyu-factory-bbq-rancho-cucamonga': 'c9d50a38-388d-4ce9-9f3f-cd355ab95567',
}

// Atlanta has no address in the sheet. From the restaurant's own page
// https://www.chubbycattle.com/project/chubby-cattle-dunwoody (Perimeter Mall),
// confirmed by Google results for 4400 Ashford Dunwoody Rd.
const ATLANTA = { address: '4400 Ashford-Dunwoody Rd', address2: 'Suite 3017', city: 'Atlanta', state: 'GA', zip: '30346', phone: '6786798383' }

const TZ: Record<string, string> = { NY: 'America/New_York', GA: 'America/New_York', CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', NV: 'America/Los_Angeles', AZ: 'America/Phoenix', CO: 'America/Denver', TX: 'America/Chicago' }

const clean = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ')
const zip5 = (v: string) => clean(v).replace(/\.0$/, '')
function phoneFmt(v: string): string | null {
  const d = clean(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (clean(v) || null)
}

function loadRows(): Row[] {
  const rows = JSON.parse(readFileSync(join(DIR, 'locations.json'), 'utf8')) as Row[]
  return rows.map(r => {
    const base = { ...r, store: clean(r.store), brand: clean(r.brand), address: clean(r.address), address2: clean(r.address2), city: clean(r.city), state: clean(r.state).toUpperCase(), zip: zip5(r.zip), phone: clean(r.phone), website: clean(r.website) }
    return r.key === 'chubby-cattle-bbq-atlanta' ? { ...base, ...ATLANTA } : base
  })
}

function hoursOf(r: Row): { hours: StoreHours; unreadable: string[] } {
  const raw: Record<string, string> = { SUNDAY: r.sun, MONDAY: r.mon, TUESDAY: r.tue, WEDNESDAY: r.wed, THURSDAY: r.thu, FRIDAY: r.fri, SATURDAY: r.sat }
  const hours: StoreHours = {}; const unreadable: string[] = []
  for (const d of STORE_DAYS) {
    const w = parseDayHours(raw[d])
    if (w === null) unreadable.push(`${d}: "${raw[d]}"`)
    else hours[d] = w
  }
  return { hours, unreadable }
}

async function locations() {
  await runMigrations()
  await ensureLocationGroups()
  const rows = loadRows()
  const plan: Array<{ key: string; store: string; ref: string; action: 'update' | 'create'; notes: string[] }> = []
  for (const r of rows) {
    const notes: string[] = []
    let ref = EXISTING[r.key]
    if (!ref) {
      // Never create a duplicate: any Disco row at the same street + ZIP whose
      // name shares the brand's first word is the same restaurant.
      const num = (r.address.match(/^\d[\d-]*/) || [''])[0]
      const hits = num ? (await sql`
        SELECT restaurant_reference, name, address FROM disco_restaurant_cache
         WHERE (address ILIKE ${num + ' %'} OR address_line1 ILIKE ${num + ' %'}) AND (address ILIKE ${'%' + r.zip + '%'} OR zipcode = ${r.zip})`) as Array<{ restaurant_reference: string; name: string; address: string }> : []
      const word = r.store.split(' ')[0].toLowerCase()
      const same = hits.filter(h => h.name.toLowerCase().includes(word) && h.name.toLowerCase().includes((r.store.split(' ')[1] || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4)))
      if (same.length) { notes.push(`would duplicate ${same.map(s => s.name).join(', ')} — STOP`); plan.push({ key: r.key, store: r.store, ref: same[0].restaurant_reference, action: 'update', notes }); continue }
      if (hits.length) notes.push(`another restaurant shares this street+ZIP: ${hits.map(h => h.name).join(', ')}`)
      ref = randomUUID()
      plan.push({ key: r.key, store: r.store, ref, action: 'create', notes })
    } else plan.push({ key: r.key, store: r.store, ref, action: 'update', notes })
    const { unreadable } = hoursOf(r)
    if (unreadable.length) notes.push('UNREADABLE HOURS ' + unreadable.join('; '))
    if (!r.address) notes.push('NO ADDRESS')
    if (!TZ[r.state]) notes.push(`no timezone for state "${r.state}"`)
  }
  for (const p of plan) console.log(`${p.action.toUpperCase().padEnd(6)} ${p.store.padEnd(36)} ${p.ref}${p.notes.length ? '  ⚠ ' + p.notes.join(' | ') : ''}`)
  if (plan.some(p => p.notes.some(n => n.includes('STOP')))) throw new Error('duplicate risk — resolve before --apply')
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); return }

  const refs: string[] = []
  for (const p of plan) {
    const r = rows.find(x => x.key === p.key)!
    const tz = TZ[r.state] || null
    const { hours } = hoursOf(r)
    if (p.action === 'create') {
      const slug = (r.store.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 50) || 'location') + '-' + p.ref.slice(0, 6)
      await sql`
        INSERT INTO disco_restaurant_cache (restaurant_reference, name, slug, phone, timezone, cuisine, is_disco_native, is_live, cached_at)
        VALUES (${p.ref}, ${r.store}, ${slug}, ${phoneFmt(r.phone)}, ${tz}, 'Other', true, false, NOW())
        ON CONFLICT (restaurant_reference) DO NOTHING`
    } else {
      await sql`
        UPDATE disco_restaurant_cache SET name = ${r.store}, phone = COALESCE(${phoneFmt(r.phone)}, phone), timezone = ${tz}, cached_at = NOW()
         WHERE restaurant_reference = ${p.ref}`
    }
    // visible = false is a literal — the one value the marketplace-switch guard allows outside lib/marketplace-switch.ts.
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, online_ordering_enabled, nash_allowed, brand, website, store_hours, updated_at)
      VALUES (${p.ref}, false, false, true, ${r.brand || null}, ${r.website || null}, ${JSON.stringify(hours)}::jsonb, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        visible = false, online_ordering_enabled = false, nash_allowed = true,
        brand = EXCLUDED.brand, website = EXCLUDED.website, store_hours = EXCLUDED.store_hours, updated_at = NOW()`
    const saved = await saveRestaurantAddress(p.ref, { line1: r.address, line2: r.address2 || null, city: r.city, state: r.state, zipcode: r.zip })
    await sql`
      INSERT INTO disco_location_groups (restaurant_reference, fm_group_id, source)
      VALUES (${p.ref}, ${GROUP}, 'primary-list') ON CONFLICT (restaurant_reference) DO NOTHING`
    await logAdminAction({ action: p.action === 'create' ? 'location_created' : 'location_updated', restaurantReference: p.ref, actorEmail: ACTOR, detail: { source: 'Chubby Group Onboarding Tracker', store: r.store, located: saved.located } })
    refs.push(p.ref)
    console.log(`${p.action} ${r.store}: ${saved.address} ${saved.located ? '' : '(NO PIN)'}`)
  }

  // Ryan: System Admin already exists — add every location, then make him the
  // group's Primary, the same two writes the Super Admin route performs.
  const [acct] = (await sql`SELECT email, role, is_primary_system_admin FROM disco_restaurant_accounts WHERE lower(email) = ${RYAN} AND archived_at IS NULL`) as Array<{ email: string; role: string; is_primary_system_admin: boolean }>
  if (!acct || String(acct.role).toUpperCase() !== 'SYSTEM_ADMIN') throw new Error('Ryan is not an active System Admin — stop')
  const have = new Set(await currentList(RYAN))
  const add = refs.filter(r => !have.has(r))
  if (add.length) await applyListChange(RYAN, add, [], ACTOR)
  await sql`UPDATE disco_restaurant_accounts SET is_primary_system_admin = TRUE, fm_group_id = ${GROUP}, updated_at = NOW() WHERE lower(email) = ${RYAN}`
  await logAdminAction({ action: 'primary_system_admin_change', restaurantReference: '', actorEmail: ACTOR, detail: { targetEmail: RYAN, primary: true, group: GROUP, locationsAdded: add.length } })
  console.log(`Ryan: +${add.length} locations, Primary of ${GROUP}`)
}

async function main() {
  const cmd = process.argv[2]
  if (cmd === 'locations') await locations()
  else if (cmd === 'menus') await (await import('./chubby-menus-2026-10')).menus(APPLY, process.argv)
  else throw new Error('usage: locations|menus [--apply]')
  process.exit(0)
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1) })

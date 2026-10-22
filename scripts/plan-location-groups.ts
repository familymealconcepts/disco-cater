/**
 * READ-ONLY PLANNER. Writes nothing to any database. Prints every grant and
 * group assignment the 22 Oct 2026 group rules imply, and saves the plan to
 * /private/tmp/claude-501/location-groups-plan.json for review. Applying is a
 * separate, explicit step (scripts/apply-location-groups-plan.ts).
 *
 *   npx tsx scripts/plan-location-groups.ts
 *
 * Peter's rules (22 Oct 2026):
 *  - Disco defines each group's locations: FamilyMeal's group plus any location
 *    created in Disco by, or assigned to, a member of the group.
 *  - Every Primary holds every location in their group (current lists are the
 *    starting point; nothing is removed). The Happy's Pizza / Savvy Sliders
 *    co-brand (FM group 131) has no Primary and gets no grants.
 *  - [COPY] locations belong to their original's group, and anyone who holds a
 *    location also gets its [COPY] versions. Nobody gets a copy without the
 *    original; such holders are listed.
 *  - A Regional who holds EVERY location of their group except the ones added
 *    in Disco after conversion also gets those. A Regional holding only some
 *    of the group gets nothing from this rule.
 *  - Talia at EggBred gets EggBred - Central Phoenix (named by Peter).
 *  - Anything that would hand someone another business's location is held back
 *    and listed instead.
 *
 * "Added in Disco after conversion" = in the group, but on none of
 * FamilyMeal's own lists for the group's Primary (read once from FamilyMeal's
 * admin API with the service account, GET only).
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { writeFileSync } from 'node:fs'
import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import { copyOriginalName } from '../lib/location-groups'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const INTERNAL = /@(familymeal|discocater)\.com$/i
const COBRAND_GROUP = '131', COBRAND_LINK = 'happyspizzacatering'
const PLAN = '/private/tmp/claude-501/location-groups-plan.json'
const brand = (s: string) => (s || '').toLowerCase().replace(/^\[copy\]\s*/, '').replace(/[’']/g, '').split(/\s[-–—|]\s|\s\(|:/)[0].replace(/[^a-z0-9]+/g, ' ').trim()

async function main() {
  const fmList = new Map<string, Set<string>>()
  for (const a of ((await (await fetch(`${FM}/api/admin/users/system-admin?size=2000`, { headers: await getFmServiceAuthHeader() })).json()).content || []) as any[]) {
    fmList.set(String(a.email || '').toLowerCase(), new Set((a.managedRestaurants || []).map((m: any) => m.reference)))
  }
  const prim = (await sql`SELECT lower(email) e, fm_group_id g, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) n FROM disco_restaurant_accounts WHERE is_primary_system_admin AND archived_at IS NULL AND fm_group_id IS NOT NULL`) as any[]
  const primaryOfGroup = new Map<string, any>(prim.map(p => [p.g, p]))
  const acct = new Map(((await sql`SELECT lower(email) e, upper(coalesce(role,'ADMIN')) role, restaurant_reference::text anchor, coalesce(is_primary_system_admin,false) p, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) n FROM disco_restaurant_accounts WHERE archived_at IS NULL AND email NOT LIKE 'stripe-import+%'`) as any[]).map(a => [a.e, a]))
  const grants = (await sql`SELECT lower(account_email) e, restaurant_reference::text r FROM disco_restaurant_location_access`) as any[]
  const info = new Map(((await sql`SELECT c.restaurant_reference::text r, c.name, o.archived_at IS NOT NULL arch, coalesce(o.is_test,false) test FROM disco_restaurant_cache c LEFT JOIN disco_restaurant_overrides o USING (restaurant_reference)`) as any[]).map(x => [x.r, x]))
  const links = (await sql`SELECT l.slug, m.restaurant_reference r FROM disco_multi_unit_links l JOIN disco_multi_unit_link_members m ON m.link_reference = l.reference WHERE l.created_by_conversion`) as any[]

  const listOf = new Map<string, Set<string>>(); for (const g of grants) (listOf.get(g.e) ?? listOf.set(g.e, new Set()).get(g.e)!).add(g.r)
  const holdersOf = new Map<string, Set<string>>(); for (const g of grants) (holdersOf.get(g.r) ?? holdersOf.set(g.r, new Set()).get(g.r)!).add(g.e)
  const linkMembers = new Map<string, string[]>(); for (const l of links) (linkMembers.get(l.slug) ?? linkMembers.set(l.slug, []).get(l.slug)!).push(l.r)
  const nm = (r: string) => info.get(r)?.name || r

  const group = new Map<string, { g: string; source: string; copyOf?: string }>()
  const forPeter = new Set<string>()
  for (const r of linkMembers.get(COBRAND_LINK) ?? []) group.set(r, { g: COBRAND_GROUP, source: 'fm-cobrand-link' })
  const contested = new Set<string>()
  const claims = new Map<string, Set<string>>()
  for (const p of prim) for (const r of listOf.get(p.e) ?? []) (claims.get(r) ?? claims.set(r, new Set()).get(r)!).add(p.g)
  for (const [r, gs] of claims) {
    if (group.has(r)) continue
    if (gs.size === 1) { group.set(r, { g: [...gs][0], source: 'primary-list' }); continue }
    let best: string | null = null, via = ''
    for (const [slug, mem] of linkMembers) {
      if (!mem.includes(r)) continue
      const sc = [...gs].map(g => ({ g, n: mem.filter(m => listOf.get(primaryOfGroup.get(g)?.e)?.has(m)).length })).sort((a, b) => b.n - a.n)
      if (sc[0].n > (sc[1]?.n ?? 0)) { best = sc[0].g; via = slug }
    }
    forPeter.add(`Two Primaries both hold "${nm(r)}" (${[...gs].map(g => primaryOfGroup.get(g)?.n + ', group ' + g).join(' / ')}). ${best ? `Placed in group ${best} because its link page /locations/${via} lists it with that group; the other Primary keeps it.` : 'Left unassigned.'}`)
    if (best) group.set(r, { g: best, source: 'link-settled' })
    else contested.add(r)
  }
  const groupsOfPerson = (e: string) => {
    const a = acct.get(e); if (!a || INTERNAL.test(e)) return new Set<string>()
    const refs = a.role === 'SYSTEM_ADMIN' ? [...(listOf.get(e) ?? [])] : [a.anchor].filter(Boolean)
    return new Set(refs.map(r => group.get(r)?.g).filter((g): g is string => !!g))
  }
  // copies follow their original
  const byName = new Map<string, string[]>(); for (const [r, i] of info) if (!copyOriginalName(i.name)) { const k = String(i.name || '').trim().toLowerCase(); (byName.get(k) ?? byName.set(k, []).get(k)!).push(r) }
  const copies: Array<{ copy: string; orig: string }> = []
  for (const [r, i] of info) {
    const on = copyOriginalName(i.name); if (!on || i.arch) continue
    const c = (byName.get(on.toLowerCase()) ?? []).filter(x => !info.get(x)?.arch)
    if (c.length !== 1) { if (holdersOf.has(r)) forPeter.add(`Could not match the copy "${i.name}" to exactly one original (${c.length} found)`); continue }
    copies.push({ copy: r, orig: c[0] })
    const og = group.get(c[0]); const cur = group.get(r)
    if (og && (!cur || cur.source === 'fm-cobrand-link')) group.set(r, { g: og.g, source: 'copy-of-original', copyOf: c[0] })
    else if (cur) cur.copyOf = c[0]
  }
  // unassigned locations join their holders' group
  for (const [r, hs] of holdersOf) {
    if (group.has(r) || contested.has(r) || !info.get(r) || info.get(r)!.arch) continue
    const gs = new Set<string>(); for (const e of hs) for (const g of groupsOfPerson(e)) gs.add(g)
    if (gs.size > 1) { forPeter.add(`"${nm(r)}" is held by people in ${gs.size} different groups — left unassigned`); continue }
    if (gs.size === 0) continue
    const g = [...gs][0]; const p = primaryOfGroup.get(g)
    if (g === COBRAND_GROUP) { group.set(r, { g, source: 'adopted-by-holders' }); continue }
    const brands = new Set([...(listOf.get(p?.e) ?? [])].map(x => brand(nm(x))))
    if (p && brands.size && !brands.has(brand(nm(r)))) { forPeter.add(`Not added to ${p.n}: "${nm(r)}" is held by someone in their group but is a different brand from everything ${p.n} holds`); continue }
    group.set(r, { g, source: 'adopted-by-holders' })
  }

  const want = new Map<string, { e: string; name: string; r: string; loc: string; rule: string }>()
  const add = (e: string, r: string, rule: string) => {
    // stripe-import+ sentinels are placeholders, never recipients (CLAUDE.md).
    if (e.startsWith('stripe-import+')) return
    if (listOf.get(e)?.has(r) || !info.get(r) || info.get(r)!.arch) return
    if (!want.has(e + '|' + r)) want.set(e + '|' + r, { e, name: acct.get(e)?.n || e, r, loc: nm(r), rule })
  }
  // Primary gets the whole group
  for (const [r, x] of group) { const p = primaryOfGroup.get(x.g); if (p && x.g !== COBRAND_GROUP) add(p.e, r, 'Primary: whole group') }
  // copies to holders of the original (including grants the Primary rule just added)
  const holds = (e: string, r: string) => listOf.get(e)?.has(r) || want.has(e + '|' + r)
  for (const { copy, orig } of copies) for (const e of new Set([...(holdersOf.get(orig) ?? []), ...[...want.values()].filter(w => w.r === orig).map(w => w.e)])) add(e, copy, `holds the original "${nm(orig)}"`)
  for (const { copy, orig } of copies) for (const e of holdersOf.get(copy) ?? []) if (!holds(e, orig)) forPeter.add(`${acct.get(e)?.n || e} (${e.split('@')[1]}) holds "${nm(copy)}" but not "${nm(orig)}" — left as is`)
  // Regionals holding the whole FamilyMeal part of their group get the Disco-added part
  const regionalSummary: string[] = []
  const groupRefs = new Map<string, string[]>(); for (const [r, x] of group) if (!info.get(r)?.arch) (groupRefs.get(x.g) ?? groupRefs.set(x.g, []).get(x.g)!).push(r)
  for (const [g, refs] of groupRefs) {
    const p = primaryOfGroup.get(g); if (!p || g === COBRAND_GROUP) continue
    const fmGroup = fmList.get(p.e) ?? new Set<string>()
    const fmPart = refs.filter(r => fmGroup.has(r)), discoAdded = refs.filter(r => !fmGroup.has(r))
    if (!fmPart.length || !discoAdded.length) continue
    let eligible = 0, alreadyAll = 0, partial = 0
    for (const [e, a] of acct) {
      if (a.role !== 'SYSTEM_ADMIN' || a.p || INTERNAL.test(e) || !groupsOfPerson(e).has(g)) continue
      const mine = listOf.get(e) ?? new Set()
      if (!fmPart.every(r => mine.has(r))) { partial++; continue }
      eligible++
      if (discoAdded.every(r => mine.has(r) || info.get(r)?.arch)) alreadyAll++
      for (const r of discoAdded) add(e, r, `Regional holding all ${fmPart.length} FamilyMeal locations of the group`)
    }
    regionalSummary.push(`${p.n} (group ${g}): ${discoAdded.length} added-in-Disco location(s) [${discoAdded.map(nm).join('; ')}] — Regionals holding the whole FamilyMeal part: ${eligible} (already hold all of these: ${alreadyAll}); Regionals holding only some: ${partial}`)
  }
  // Peter's named grant
  const cp = [...info].find(([, i]) => i.name === 'EggBred - Central Phoenix')?.[0]
  if (cp) add('talia@eggbred.com', cp, 'named by Peter')
  // anything crossing businesses is held back
  const plan = [...want.values()].filter(w => {
    const gs = groupsOfPerson(w.e); const g = group.get(w.r)?.g
    const ok = w.rule === 'named by Peter' || INTERNAL.test(w.e) || !g || gs.has(g) || w.rule.startsWith('holds the original')
    if (!ok) forPeter.add(`Held back: ${w.name} <- "${w.loc}" (location is in group ${g}, ${w.name} is not)`)
    return ok
  })
  for (const p of prim) for (const r of listOf.get(p.e) ?? []) { const g = group.get(r)?.g; if (g && g !== p.g && !info.get(r)?.arch) forPeter.add(`${p.n} (Primary, group ${p.g}) holds "${nm(r)}", which belongs to group ${g === COBRAND_GROUP ? '131 (Happy’s/Savvy co-brand)' : g} — left as is`) }

  // People who reached a copy only through the retired link-page rule and do not
  // hold its original (Peter: list them, don't grant). From the 22 Oct analysis.
  try {
    const old = JSON.parse((await import('node:fs')).readFileSync('/private/tmp/claude-501/grants.json', 'utf8'))
    for (const row of old.rows || []) {
      if (!copyOriginalName(row.extra)) continue
      const cr = [...info].find(([, i]) => i.name === row.extra)?.[0]
      const orig = copies.find(c => c.copy === cr)?.orig
      if (cr && orig && !holds(row.email, orig) && !holds(row.email, cr)) forPeter.add(`${String(row.name).replace(/\s+/g, ' ').trim()} (${row.email.split('@')[1]}) reached "${row.extra}" through the old link rule but does not hold "${nm(orig)}" — not given`)
    }
  } catch { /* analysis file not present */ }

  const groupRows = [...group].map(([r, x]) => ({ r, g: x.g, source: x.source, copyOf: x.copyOf || null }))
  writeFileSync(PLAN, JSON.stringify({ groupRows, grants: plan.map(w => ({ e: w.e, r: w.r, rule: w.rule })), forPeter: [...forPeter] }, null, 1))
  console.log(`locations placed in groups: ${groupRows.length}`)
  console.log(`grants to add: ${plan.length}\n`)
  const byPerson = new Map<string, typeof plan>(); for (const w of plan) (byPerson.get(w.e) ?? byPerson.set(w.e, []).get(w.e)!).push(w)
  for (const [e, ws] of [...byPerson].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${ws[0].name} <${e}>  +${ws.length}`)
    for (const w of ws) console.log(`    ${w.loc}${info.get(w.r)?.test ? ' [test]' : ''}   — ${w.rule}`)
  }
  console.log(`\nRegional rule, groups with locations added in Disco after conversion (${regionalSummary.length}):`); for (const x of regionalSummary) console.log('  ' + x)
  console.log(`\nFor Peter (${forPeter.size}):`); for (const s of forPeter) console.log('  - ' + s)
  console.log(`\nplan saved to ${PLAN}`)
  process.exit(0)
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1) })

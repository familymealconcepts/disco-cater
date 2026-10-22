// APPLIED 22 Oct 2026 (inserted 15). Before FamilyMeal-password System Admins
// were switched to Disco's list, this added the 15 grants the 839-grant analysis
// judged real: owners/brand staff one or two of their OWN locations short, which
// they reached only through the retired multi-unit-link rule (Namkeen Astoria,
// Stacks & Cordials Southfield, EggBred/Atlanta Bread/Savvy Sliders staff). The
// 806 cross-business and 18 test/[COPY] grants were deliberately NOT added.
// granted_by = 'link-rule-retirement-2026-10-22'. Re-running finds nothing left to add.
//   npx tsx scripts/add-link-rule-real-grants.ts [--apply]
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const APPLY = process.argv.includes('--apply')
const EXPECT: Record<string, string[]> = { // person-name match -> expected extra location names
  'Freeha Chaudhri': ['Namkeen - Astoria'], 'Hasan Zafar': ['Namkeen - Astoria'], 'Usman Chaudhri': ['Namkeen - Astoria'], 'Mahady Keita': ['Namkeen - Astoria'],
  'Marcus Karana': ['Stacks & Cordials - Southfield'], 'Alexander Karana': ['Stacks & Cordials - Southfield'],
  'Paul Nam': [], 'Allen Park': [], 'Mason Ha': [], 'Kim Jensen-Pitts@atlantabread.com': [], 'Tatum McKenzie': [],
  'Barbara Coultas': ['Savvy Sliders - Detroit (Midtown)'], 'Jessica Roberts': ['Savvy Sliders - Oak Park', 'Savvy Sliders - Brook Park'],
}
const OWNER_EMAILS_DOMAINS = ['eatnamkeen.com', 'stacksncordials.com']
async function main() {
  const h = await getFmServiceAuthHeader()
  const fm = ((await (await fetch(`${FM}/api/admin/users/system-admin?size=2000`, { headers: h })).json()).content || []) as any[]
  const accts = new Map(((await sql`SELECT lower(email) e, password_set_at IS NOT NULL pw, archived_at IS NOT NULL arch FROM disco_restaurant_accounts`) as any[]).map(r => [r.e, r]))
  const grants = new Map<string, Set<string>>()
  for (const g of (await sql`SELECT lower(account_email) e, restaurant_reference r FROM disco_restaurant_location_access`) as any[]) { if (!grants.has(g.e)) grants.set(g.e, new Set()); grants.get(g.e)!.add(g.r) }
  const info = new Map<string, any>(((await sql`SELECT c.restaurant_reference::text r, c.name, c.is_disco_native native, o.archived_at IS NOT NULL arch FROM disco_restaurant_cache c LEFT JOIN disco_restaurant_overrides o USING (restaurant_reference)`) as any[]).map(x => [x.r, x]))
  const mem = (await sql`SELECT link_reference::text l, restaurant_reference r FROM disco_multi_unit_link_members`) as any[]
  const byRef = new Map<string, string[]>(), byLink = new Map<string, string[]>()
  for (const m of mem) { (byRef.get(m.r) ?? byRef.set(m.r, []).get(m.r)!).push(m.l); (byLink.get(m.l) ?? byLink.set(m.l, []).get(m.l)!).push(m.r) }
  const out: Array<{ email: string; ref: string; name: string }> = []
  for (const a of fm) {
    const e = (a.email || '').toLowerCase(); const acct = accts.get(e)
    if (!e || (acct && (acct.pw || acct.arch))) continue
    const name = `${a.firstName || ''} ${a.lastName || ''}`.replace(/\s+/g, ' ').trim()
    const key = Object.keys(EXPECT).find(k => k.includes('@') ? `${name}@${e.split('@')[1]}` === k : name === k)
    if (!key) continue
    const fmRefs = new Set<string>((a.managedRestaurants || []).map((m: any) => m.reference))
    const disco = grants.get(e) ?? new Set()
    const extra = new Set<string>()
    for (const r of fmRefs) for (const l of byRef.get(r) || []) for (const s of byLink.get(l) || []) if (info.get(s)?.native && !fmRefs.has(s) && !disco.has(s) && !info.get(s)?.arch) extra.add(s)
    for (const s of extra) out.push({ email: e, ref: s, name: info.get(s).name })
    const want = EXPECT[key]
    if (want.length && JSON.stringify([...extra].map(s => info.get(s).name).sort()) !== JSON.stringify([...want].sort())) console.log('MISMATCH', key, [...extra].map(s => info.get(s).name))
  }
  for (const o of out) console.log(o.email.padEnd(36), o.name)
  console.log('total', out.length, 'people', new Set(out.map(o => o.email)).size)
  if (APPLY) {
    if (out.length !== 15) { console.log('REFUSING: expected 15'); process.exit(1) }
    const r = await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT u.e, u.r, 'link-rule-retirement-2026-10-22' FROM unnest(${out.map(o => o.email)}::text[], ${out.map(o => o.ref)}::text[]) AS u(e, r)
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING RETURNING account_email`
    console.log('inserted', (r as any[]).length)
  }
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })

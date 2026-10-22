/**
 * Seeds Disco's SINGLE location list per System Admin, and stamps the Primary.
 *
 * Disco is now the source of truth for which locations a System Admin reaches
 * (Peter, 21 Oct 2026). This script is the one-time hand-off: it reads
 * FamilyMeal ONCE — tbl_restaurant_groups, tbl_restaurant_groups_system_admins,
 * tbl_system_admin_restaurants, tbl_users.created_date — and writes only to
 * Disco. It NEVER writes to FamilyMeal.
 *
 *   list = FM assigned locations
 *        ∪ current disco_restaurant_location_access
 *        ∪ every location in the person's group, IF they are the Primary
 *
 * UNION, so nobody loses a location. Verified in the dry run: 0 losses.
 *
 * PRIMARY = the first SYSTEM_ADMIN created for the FM RestaurantGroup, by
 * tbl_users.created_date.
 *
 * ── THE ONE GROUP THAT IS SKIPPED ───────────────────────────────────────────
 * "Happys Pizza and Savvy Sliders Co-Brand" (FM group 131) is TWO businesses
 * in one FM group, and its earliest-created System Admin holds 2 of 57
 * locations and looks like a single franchise store rather than an owner.
 * Applying the rule there would hand a franchisee access to 55 locations
 * across both brands. Peter's decision: skip the Primary for that group;
 * everyone keeps exactly what they have, and a Super Admin can set a Primary
 * later. SKIP_PRIMARY_GROUPS is that decision, written down.
 *
 * Reads FM through the documented tunnel:
 *   ssh -f -N -L 55432:10.108.0.6:5432 root@68.183.151.221
 *
 *   npx tsx scripts/migrate-system-admin-locations.ts --dry-run
 *   npx tsx scripts/migrate-system-admin-locations.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { Client } from 'pg'
import { runMigrations, sql } from '../lib/db'

const APPLY = process.argv.includes('--apply')
const unq = (v?: string) => (v || '').replace(/^["']|["']$/g, '')
const isSentinel = (e: string) => e.startsWith('stripe-import+')

/** FM groups that must NOT get a Primary. See the header. */
const SKIP_PRIMARY_GROUPS = new Set(['131']) // Happys Pizza and Savvy Sliders Co-Brand

function fmClient() {
  const port = Number(process.env.FM_DB_TUNNEL_PORT || 55432)
  return new Client({
    host: '127.0.0.1', port,
    database: unq(process.env.FM_DB_NAME), user: unq(process.env.FM_DB_USER),
    password: unq(process.env.FM_DB_PASSWORD),
    ssl: { rejectUnauthorized: false }, statement_timeout: 120_000,
  })
}

async function main() {
  await runMigrations()
  const fm = fmClient()
  await fm.connect()

  // ── READ FAMILYMEAL. SELECT ONLY. ───────────────────────────────────────
  const gr = await fm.query(`
    SELECT rg.id::text AS group_id, rg.name AS group_name, r.reference::text AS ref
      FROM familymeal.tbl_restaurant_groups rg
      LEFT JOIN familymeal.tbl_restaurants r ON r.group_id = rg.id AND r.is_deleted = false`)
  const ga = await fm.query(`
    SELECT rgs.group_id::text AS group_id, lower(u.email) AS email, u.created_date, u.id AS user_id
      FROM familymeal.tbl_restaurant_groups_system_admins rgs
      JOIN familymeal.tbl_users u ON u.id = rgs.user_id
     ORDER BY rgs.group_id, u.created_date ASC, u.id ASC`)
  const sar = await fm.query(`
    SELECT lower(u.email) AS email, r.reference::text AS ref
      FROM familymeal.tbl_system_admin_restaurants sar
      JOIN familymeal.tbl_users u ON u.id = sar.user_id
      JOIN familymeal.tbl_restaurants r ON r.id = sar.restaurant_id AND r.is_deleted = false`)
  await fm.end()

  const groupRefs = new Map<string, Set<string>>()
  const groupName = new Map<string, string>()
  for (const r of gr.rows) {
    groupName.set(r.group_id, r.group_name)
    if (!r.ref) continue
    if (!groupRefs.has(r.group_id)) groupRefs.set(r.group_id, new Set())
    groupRefs.get(r.group_id)!.add(r.ref)
  }
  const groupAdmins = new Map<string, any[]>()
  for (const a of ga.rows) {
    if (isSentinel(a.email)) continue
    if (!groupAdmins.has(a.group_id)) groupAdmins.set(a.group_id, [])
    groupAdmins.get(a.group_id)!.push(a)
  }
  const fmAssign = new Map<string, Set<string>>()
  for (const a of sar.rows) {
    if (!fmAssign.has(a.email)) fmAssign.set(a.email, new Set())
    fmAssign.get(a.email)!.add(a.ref)
  }

  // ── CURRENT DISCO STATE ─────────────────────────────────────────────────
  const have = new Map<string, Set<string>>()
  for (const r of (await sql`SELECT lower(account_email) e, restaurant_reference::text r
      FROM disco_restaurant_location_access` as any[])) {
    if (!have.has(r.e)) have.set(r.e, new Set())
    have.get(r.e)!.add(r.r)
  }
  const knownRefs = new Set((await sql`SELECT restaurant_reference::text r FROM disco_restaurant_cache` as any[]).map((x: any) => x.r))

  // ── TARGET LIST PER PERSON ──────────────────────────────────────────────
  const primaryOf = new Map<string, string>()  // group -> email
  for (const [gid, admins] of groupAdmins) {
    if (SKIP_PRIMARY_GROUPS.has(gid)) continue
    if (admins.length) primaryOf.set(gid, admins[0].email)
  }
  const groupOf = new Map<string, string>()
  for (const [gid, admins] of groupAdmins) for (const a of admins) groupOf.set(a.email, gid)

  const emails = new Set<string>([...fmAssign.keys(), ...have.keys(), ...groupOf.keys()])
  let addedGrants = 0, people = 0, primaries = 0, skippedUnknown = 0
  const toInsert: Array<{ email: string; ref: string }> = []
  const primaryRows: Array<{ email: string; gid: string }> = []

  for (const email of emails) {
    if (isSentinel(email)) continue
    const gid = groupOf.get(email)
    const isPrimary = !!gid && primaryOf.get(gid) === email
    const mine = have.get(email) ?? new Set<string>()
    const target = new Set<string>([...(fmAssign.get(email) ?? []), ...mine])
    if (isPrimary) for (const r of (groupRefs.get(gid!) ?? [])) target.add(r)
    const add = [...target].filter(r => !mine.has(r))
    // A reference Disco has never heard of cannot be granted — the portal
    // resolves every location through disco_restaurant_cache.
    const grantable = add.filter(r => knownRefs.has(r))
    skippedUnknown += add.length - grantable.length
    if (grantable.length) { people++; addedGrants += grantable.length
      for (const r of grantable) toInsert.push({ email, ref: r }) }
    if (isPrimary) { primaries++; primaryRows.push({ email, gid: gid! }) }
  }

  console.log(APPLY ? '── APPLYING ──' : '── DRY RUN (nothing written) ──')
  console.log('  FM groups: ' + groupRefs.size + '   Primaries to stamp: ' + primaries +
              '   (skipped group(s): ' + [...SKIP_PRIMARY_GROUPS].map(g => groupName.get(g) ?? g).join(', ') + ')')
  console.log('  people gaining locations: ' + people)
  console.log('  grants to write:          ' + addedGrants)
  console.log('  refs skipped (unknown to Disco): ' + skippedUnknown)

  if (!APPLY) { console.log('\n  re-run with --apply to write.'); process.exit(0) }

  // ── WRITE. DISCO ONLY. ──────────────────────────────────────────────────
  const CH = 200
  for (let i = 0; i < toInsert.length; i += CH) {
    const chunk = toInsert.slice(i, i + CH)
    await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by, invited_by)
      SELECT u.email, u.ref, 'migration:fm-union-2026-10-21', 'migration:fm-union-2026-10-21'
        FROM unnest(${chunk.map(c => c.email)}::text[], ${chunk.map(c => c.ref)}::text[]) AS u(email, ref)
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING`
  }
  console.log('  grants written: ' + toInsert.length)

  for (let i = 0; i < primaryRows.length; i += CH) {
    const chunk = primaryRows.slice(i, i + CH)
    await sql`
      UPDATE disco_restaurant_accounts a
         SET is_primary_system_admin = TRUE, fm_group_id = u.gid, updated_at = NOW()
        FROM unnest(${chunk.map(c => c.email)}::text[], ${chunk.map(c => c.gid)}::text[]) AS u(email, gid)
       WHERE lower(a.email) = u.email`
  }
  console.log('  Primary tags stamped: ' + primaryRows.length)

  const after = (await sql`SELECT COUNT(*)::int n FROM disco_restaurant_location_access` as any[])[0].n
  const prim = (await sql`SELECT COUNT(*)::int n FROM disco_restaurant_accounts WHERE is_primary_system_admin` as any[])[0].n
  console.log('\n  disco_restaurant_location_access rows now: ' + after)
  console.log('  accounts flagged Primary:                  ' + prim)
  process.exit(0)
}

main().catch(e => { console.error('ERR ' + (e?.stack || e?.message || e)); process.exit(1) })

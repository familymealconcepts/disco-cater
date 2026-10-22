/**
 * Applies EXACTLY the plan scripts/plan-location-groups.ts printed and saved —
 * nothing is recomputed here, so what was reviewed is what lands. Only adds:
 * disco_location_groups rows (ON CONFLICT DO NOTHING) and the planned grants
 * (ON CONFLICT DO NOTHING). Applied 22 Oct 2026.
 *
 *   npx tsx scripts/apply-location-groups-plan.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { readFileSync } from 'node:fs'
import { sql } from '../lib/db'
import { ensureLocationGroups } from '../lib/location-groups'

const PLAN = '/private/tmp/claude-501/location-groups-plan.json'

async function main() {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as {
    groupRows: Array<{ r: string; g: string; source: string; copyOf: string | null }>
    grants: Array<{ e: string; r: string; rule: string }>
  }
  if (plan.grants.some(g => g.e.startsWith('stripe-import+'))) throw new Error('plan contains a sentinel recipient; refusing')
  await ensureLocationGroups()
  const CH = 200
  let groupsWritten = 0, grantsWritten = 0
  for (let i = 0; i < plan.groupRows.length; i += CH) {
    const c = plan.groupRows.slice(i, i + CH)
    const res = (await sql`
      INSERT INTO disco_location_groups (restaurant_reference, fm_group_id, source, copy_of)
      SELECT u.r, u.g, u.s, NULLIF(u.c, '')
        FROM unnest(${c.map(x => x.r)}::text[], ${c.map(x => x.g)}::text[], ${c.map(x => x.source)}::text[], ${c.map(x => x.copyOf || '')}::text[]) AS u(r, g, s, c)
      ON CONFLICT (restaurant_reference) DO NOTHING
      RETURNING 1`) as unknown[]
    groupsWritten += res.length
  }
  for (let i = 0; i < plan.grants.length; i += CH) {
    const c = plan.grants.slice(i, i + CH)
    const res = (await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT u.e, u.r, 'location-groups-2026-10-22'
        FROM unnest(${c.map(x => x.e)}::text[], ${c.map(x => x.r)}::text[]) AS u(e, r)
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING
      RETURNING 1`) as unknown[]
    grantsWritten += res.length
  }
  console.log(`group rows written: ${groupsWritten} of ${plan.groupRows.length}; grants written: ${grantsWritten} of ${plan.grants.length}`)
  process.exit(0)
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1) })

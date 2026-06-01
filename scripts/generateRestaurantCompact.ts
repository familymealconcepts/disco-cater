// Regenerates scripts/output/restaurant-compact.json from the live FM API,
// keyed by Sanity's canonical restaurant list. The generation logic now lives
// in lib/generateCompact.ts (shared with the cron + webhook automation routes);
// this file is the thin CLI wrapper that keeps the --limit / --dry-run flags.
//
// Run from the disco-cater folder:
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts --limit=5 --dry-run
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts --limit=5
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts        # full run
//
// Flags:
//   --limit=N    process only the first N Sanity restaurants (safe testing)
//   --dry-run    print what would be written; do not touch the file
//
// Env:
//   FM_API_BASE_URL   optional, defaults to https://api.familymeal.com

import { generateCompact, writeCompactFile } from '../lib/generateCompact'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined

async function main() {
  const { entries } = await generateCompact({ limit: LIMIT, log: (m) => console.log(m) })

  if (DRY_RUN) {
    console.log('\n--dry-run: NOT writing the file. Sample output (up to 3 entries):')
    console.log(JSON.stringify(entries.slice(0, 3), null, 2))
    return
  }

  const { path: outPath, sizeKb } = writeCompactFile(entries)
  console.log(`\nWrote ${entries.length} entries → ${outPath} (${sizeKb} KB)`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})

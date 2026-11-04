/**
 * Hold Payments DRY RUN: what the Super Admin toggle would do for a restaurant, writing nothing.
 *
 *   npx tsx scripts/money-flow-dry-run.ts <restaurantRef> <FAMILY_MEAL|DIRECT> [<ref> <flow> ...]
 *
 * Reads Disco and FamilyMeal live through the same code the toggle uses
 * (lib/money-flow-sync.ts), in dryRun mode. As a second guard every write function is replaced by
 * one that throws, so even a bug in dryRun could not change either system.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

async function main() {
  const { setMoneyFlowEverywhere, parseMoneyFlow } = await import('../lib/money-flow-sync')
  const { moneyFlowDeps, fmRefFor } = await import('../lib/money-flow-sync-server')
  const { isDiscoNativeRestaurant } = await import('../lib/order/native-checkout')
  const { getFmServiceAuthHeader } = await import('../lib/fm-service-auth')
  const args = process.argv.slice(2)
  const h = await getFmServiceAuthHeader()
  for (let i = 0; i < args.length; i += 2) {
    const ref = args[i]
    const flow = parseMoneyFlow(args[i + 1])
    if (!flow) throw new Error(`bad flow for ${ref}: ${args[i + 1]}`)
    const native = await isDiscoNativeRestaurant(ref)
    const fmRef = native ? await fmRefFor(ref) : ref
    const deps = moneyFlowDeps(h, { ref, actorEmail: 'dry-run', native, fmRef })
    const refuse = (what: string) => async () => { throw new Error(`DRY RUN: ${what} must not be called`) }
    const r = await setMoneyFlowEverywhere(
      { ...deps, fmPut: refuse('fmPut'), discoWrite: refuse('discoWrite'), cacheWrite: refuse('cacheWrite'), audit: refuse('audit') },
      { ref, fmRef, flow, native, dryRun: true },
    )
    console.log(JSON.stringify({ ref, fmRef, native, ...r }, null, 2))
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

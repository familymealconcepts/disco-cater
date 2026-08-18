// One-time backfill: fills icon_url, image_url, and phone on
// disco_restaurant_cache for existing native restaurants that were converted
// before convertToNative carried these fields over (lib/native-conversion.ts's
// carryOverProfileFields). Fill-blank-only — never overwrites an existing
// value. Only restaurants with a real FM record (disco_restaurant_accounts
// .fm_restaurant_reference IS NOT NULL) have anything to backfill from; a
// pure native-only restaurant has no FM row to read.
//
// Modes:
//   npx tsx scripts/backfill-conversion-profile-fields.ts             dry run, no writes (default)
//   npx tsx scripts/backfill-conversion-profile-fields.ts --execute   real writes
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import { fmImageUrl } from '../lib/fm-image'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const EXECUTE = process.argv.includes('--execute')

async function main() {
  const rows = (await sql`
    SELECT c.restaurant_reference, c.name, c.icon_url, c.image_url, c.phone, a.fm_restaurant_reference
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_accounts a ON a.restaurant_reference = c.restaurant_reference
    WHERE c.is_disco_native = true
      AND (c.icon_url IS NULL OR c.image_url IS NULL OR c.phone IS NULL)
    ORDER BY c.name
  `) as {
    restaurant_reference: string; name: string | null
    icon_url: string | null; image_url: string | null; phone: string | null
    fm_restaurant_reference: string | null
  }[]

  console.log(`${rows.length} native restaurant(s) missing at least one of icon_url/image_url/phone.`)
  console.log(EXECUTE ? '=== EXECUTE MODE — writing real changes ===' : '=== DRY RUN — no writes (pass --execute for real) ===')

  let auth: Record<string, string> | null = null
  let gainedIcon = 0, gainedImage = 0, gainedPhone = 0
  let noFmRecord = 0, fmHasNothing = 0, fmUnreachable = 0

  for (const r of rows) {
    if (!r.fm_restaurant_reference) {
      noFmRecord++
      console.log(`  [no-fm] ${r.name} (${r.restaurant_reference}) — no FM record, nothing to backfill from`)
      continue
    }

    if (!auth) { try { auth = await getFmServiceAuthHeader() } catch (e) { console.error('FM auth failed:', e); break } }

    let fmRestaurant: { image?: unknown; marketplaceImage?: unknown; address?: { phoneNumber?: string } } | null = null
    try {
      const res = await fetch(`${FM}/api/admin/restaurants/${r.fm_restaurant_reference}`, { headers: { ...auth, Accept: 'application/json' } })
      if (res.ok) fmRestaurant = await res.json().catch(() => null)
    } catch { /* treated as unreachable below */ }

    if (!fmRestaurant) {
      fmUnreachable++
      console.log(`  [unreachable] ${r.name} (${r.restaurant_reference}) — FM lookup failed`)
      continue
    }

    const fmIconUrl = fmImageUrl(fmRestaurant.image)
    const fmImgUrl = fmImageUrl(fmRestaurant.marketplaceImage)
    const fmPhone = fmRestaurant.address?.phoneNumber?.trim() || null

    const setIcon = !r.icon_url && !!fmIconUrl
    const setImage = !r.image_url && !!fmImgUrl
    const setPhone = !r.phone && !!fmPhone

    if (!setIcon && !setImage && !setPhone) {
      fmHasNothing++
      console.log(`  [fm-empty] ${r.name} (${r.restaurant_reference}) — FM has nothing for the still-missing field(s) either`)
      continue
    }

    if (setIcon) gainedIcon++
    if (setImage) gainedImage++
    if (setPhone) gainedPhone++
    console.log(`  [gain] ${r.name} (${r.restaurant_reference}) — icon:${setIcon} image:${setImage} phone:${setPhone}`)

    if (EXECUTE) {
      await sql`
        UPDATE disco_restaurant_cache
        SET icon_url = COALESCE(icon_url, ${fmIconUrl}),
            image_url = COALESCE(image_url, ${fmImgUrl}),
            phone = COALESCE(phone, ${fmPhone}),
            cached_at = NOW()
        WHERE restaurant_reference = ${r.restaurant_reference}
      `
    }
  }

  console.log('\n--- Summary ---')
  console.log(`Checked: ${rows.length}`)
  console.log(`Gained a logo (icon_url): ${gainedIcon}`)
  console.log(`Gained a marketplace image (image_url): ${gainedImage}`)
  console.log(`Gained a phone: ${gainedPhone}`)
  console.log(`No FM record at all (nothing to backfill from): ${noFmRecord}`)
  console.log(`FM record reachable but has nothing for the missing field(s) either: ${fmHasNothing}`)
  console.log(`FM unreachable (error/timeout): ${fmUnreachable}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

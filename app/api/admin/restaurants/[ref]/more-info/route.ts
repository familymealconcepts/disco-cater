import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { normalizeMoreInfo, MORE_INFO_MAX } from '../../../../../../lib/more-info'
import { readMoreInfo, saveMoreInfo } from '../../../../../../lib/more-info-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Super Admin's view of a restaurant's "More Info" (lib/more-info.ts).
//
// A Disco-native restaurant with a leftover FM reference is listed under that FM ref, but its
// overrides live on the NATIVE ref (what the ordering page reads), so the same remap
// restaurant-overrides' PATCH does is applied to both the read and the write here.
async function canonicalRef(ref: string): Promise<string> {
  try {
    const nr = (await sql`
      SELECT restaurant_reference AS native_ref FROM disco_restaurant_accounts
      WHERE is_disco_native = true AND fm_restaurant_reference = ${ref} LIMIT 1
    `) as { native_ref: string }[]
    return nr[0]?.native_ref || ref
  } catch {
    return ref
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref: claimed } = await params
  await runMigrations()
  const ref = await canonicalRef(claimed)
  return NextResponse.json({ restaurantReference: ref, moreInfo: (await readMoreInfo(ref)) ?? '' })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref: claimed } = await params
  const body = await req.json().catch(() => null)
  if (typeof body?.moreInfo === 'string' && body.moreInfo.length > MORE_INFO_MAX * 2) {
    return NextResponse.json({ error: `More Info is limited to ${MORE_INFO_MAX} characters` }, { status: 400 })
  }
  await runMigrations()
  const ref = await canonicalRef(claimed)
  const value = normalizeMoreInfo(body?.moreInfo)
  await saveMoreInfo({
    ref, value, action: 'admin_overrides_update', actorEmail: await getAdminEmail(), authType: 'admin',
    extra: claimed !== ref ? { claimedRef: claimed, remappedToNativeRef: true } : undefined,
  })
  return NextResponse.json({ ok: true, moreInfo: value ?? '' })
}

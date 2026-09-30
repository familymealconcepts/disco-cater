import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import { loadNativeEditMenu } from '../../../../lib/menu/native-edit-menu'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The menu the order-edit dialog offers, for a Disco-native restaurant.
//
// Answers `{ native: false }` for an FM-backed restaurant so the caller keeps
// using /api/fm-menu + /api/fm-packages, which remain correct for the ~3,400
// restaurants that have not converted. Once a restaurant IS native, Disco owns
// its menu and FamilyMeal's copy is a stale snapshot — see
// lib/menu/native-edit-menu.ts for the defect that caused.
//
// Deliberately NOT auth-gated beyond the portal's own session: this is the same
// menu the public restaurant page already serves to anyone, so it exposes
// nothing new. It takes the restaurant reference explicitly rather than reading
// the session's selected location, because the dialog edits a SPECIFIC order and
// must show that order's restaurant, not whatever is currently selected.
export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get('ref') || '').trim()
  if (!ref) return NextResponse.json({ error: 'Missing ref' }, { status: 400 })
  try {
    await runDiscoOrderMigrations()
    const sections = await loadNativeEditMenu(ref)
    if (sections === null) return NextResponse.json({ native: false })
    return NextResponse.json({ native: true, sections })
  } catch (err) {
    console.error('[order-edit-menu] failed:', err instanceof Error ? err.message : err)
    // Fall back rather than fail: the caller treats an error like a non-native
    // answer and loads the FamilyMeal menu, so editing still works.
    return NextResponse.json({ native: false })
  }
}

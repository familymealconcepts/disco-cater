import { NextResponse } from 'next/server'

// ── NO LONGER WRITES TO FAMILYMEAL (22 Oct 2026) ──────────────────────────────
// Disco owns users and their locations and never writes changes to FamilyMeal
// (Peter). This route used to proxy edit and delete to FM's /api/system-admin/users,
// which created/edited/deleted FamilyMeal users and their location lists. The
// team screen now saves to Disco for every session (app/api/restaurant/team*),
// so the write is refused here rather than forwarded. Reads are unchanged.
export async function PUT() {
  return NextResponse.json({
    error: 'Team changes are saved in Disco Cater now. Reload the Authorized Users page to manage this person.',
  }, { status: 410 })
}

export async function DELETE() {
  return NextResponse.json({
    error: 'Team changes are saved in Disco Cater now. Reload the Authorized Users page to manage this person.',
  }, { status: 410 })
}

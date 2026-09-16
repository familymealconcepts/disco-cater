import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { isDiscoNativeRestaurant } from '../../../../lib/order/native-checkout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Is the restaurant currently in scope Disco-native?
//
// EXISTS SO THE NAV CAN KEY ON THE RESTAURANT INSTEAD OF THE SESSION. The portal
// layout used to point "Manage Menus" at the FM-backed manage-v2 screens unless
// the SESSION was Disco — so an FM session (which is what the master password
// issues, and how the Disco Cater team works every day) landed on FamilyMeal's
// menu screens even for a native restaurant, whose menus FM does not own.
//
// Answers for BOTH session types: a disco session resolves its own scope ref, an
// FM session resolves the selected-location ref. Never throws — an unknown answer
// is `native: false`, which preserves today's behaviour rather than hiding menus
// from an FM-backed restaurant on a transient error.
export async function GET(req: NextRequest) {
  try {
    const explicit = req.nextUrl.searchParams.get('ref')
    let ref = explicit || ''
    if (!ref) {
      const ctx = await getRestaurantAuthContext()
      if (!ctx) return NextResponse.json({ native: false, reference: null })
      ref = ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : ((await getRestaurantRef()) || '')
    }
    if (!ref) return NextResponse.json({ native: false, reference: null })
    return NextResponse.json({ native: await isDiscoNativeRestaurant(ref), reference: ref })
  } catch {
    return NextResponse.json({ native: false, reference: null })
  }
}

import { NextResponse } from 'next/server'
import { isDiscoNativeRestaurant } from './order/native-checkout'

/**
 * The guard for every FamilyMeal-backed MENU route.
 *
 * ── THE RULE THIS ENFORCES ──────────────────────────────────────────────────
 * Converting a restaurant to Disco-native means Disco owns its menus. These
 * routes — meal-packages, categories, groups, add-ons, closed-days, images and
 * menus — proxy FamilyMeal, so for a native restaurant they read and, worse,
 * WRITE the wrong system. Disco's own menu API (disco-menus, disco-menu-items,
 * disco-menu-categories, disco-modifiers, disco-modifier-groups,
 * disco-closed-days) is where a native restaurant's menus actually live.
 *
 * ── WHY A GUARD AND NOT A BRANCH ────────────────────────────────────────────
 * These routes have no native equivalent to fall through to — the native UI is a
 * different surface (menu-manager) with a different API and a different data
 * shape. Silently redirecting a write here would be guesswork. Refusing is the
 * honest answer, and it is what makes a stale bookmark or a hand-typed URL safe:
 * there is no path from this route to a wrong write.
 *
 * ── KEYED ON THE RESTAURANT, NEVER THE SESSION ──────────────────────────────
 * The nav sends Disco sessions to menu-manager, but that check reads the SESSION
 * type — so anyone holding an FM session (which is what the master password
 * produces, and how the Disco Cater team works every day) was routed to the FM
 * menu screens even for a native restaurant. That is the defect shape this repo
 * keeps repeating: deciding from the caller's cookie rather than from the thing
 * that matters. This guard reads the restaurant.
 *
 * Worked example: Stacks & Cordials - Clawson (native since 2026-09-11) opened at
 * /restaurant/manage-v2/13f44813…/8ec2b560… — both FamilyMeal references, neither
 * present in disco_menus or disco_menu_categories — while its real menus (2
 * menus, 80 items) sat in Disco. The read failed, which is the only reason no
 * edit was written into FamilyMeal.
 */
export async function refuseIfNativeMenuSurface(ref: string | null | undefined): Promise<NextResponse | null> {
  if (!ref) return null
  if (!(await isDiscoNativeRestaurant(ref))) return null
  return NextResponse.json(
    {
      error:
        'This restaurant’s menus are managed in Disco Cater, not FamilyMeal. Open Manage Menus from the sidebar to edit them — this page is the FamilyMeal menu screen and cannot read or change a Disco-native restaurant.',
      reason: 'native-restaurant-wrong-menu-surface',
      // Where the caller SHOULD be. Named so a client can redirect rather than
      // only apologise, and so the reason is legible in a log.
      useInstead: '/restaurant/menu-manager',
    },
    { status: 409 },
  )
}

/**
 * Disco-native restaurants that FamilyMeal has never heard of.
 *
 * Every super-admin restaurant list proxies a FamilyMeal endpoint. A restaurant
 * CONVERTED from FM keeps its FM record and so still appears; a restaurant
 * created natively on Disco Cater has no FM record at all and was simply absent
 * — invisible in the restaurant filter dropdowns, the Menu Import picker and the
 * Marketplace list. Measured on 2026-09-16: 26 of 214 native restaurants, of
 * which the live non-test ones include Almost Home, Aztec Dave's Cantina,
 * Blasteran, Cena Vegan, Crimson Coward - Frisco, Lee's Chinese Food and
 * Rendang Republic.
 *
 * These helpers return ONLY the restaurants FM cannot return, so nothing is
 * duplicated when a merge is applied over an FM response.
 */
import { sql } from '../db'

export interface NativeOnlyRestaurant {
  reference: string
  businessName: string
  city: string | null
  state: string | null
  /** Marketplace visibility. Disco's own flag — FM's `blocked` does not govern it. */
  isLive: boolean
  createdDate: string | undefined
}

/**
 * Native restaurants with no row in the FamilyMeal admin-list cache — i.e. the
 * ones FM's own endpoints cannot return. `search` matches the name, the same
 * way FM's `search`/`searchName` parameters do.
 */
export async function nativeOnlyRestaurants(search?: string | null, limit = 200): Promise<NativeOnlyRestaurant[]> {
  try {
    const q = search && search.trim() ? `%${search.trim().toLowerCase()}%` : null
    const rows = (await sql`
      SELECT c.restaurant_reference::text AS reference, c.name, c.city, c.state,
             COALESCE(c.is_live, false) AS is_live, c.cached_at
        FROM disco_restaurant_cache c
        LEFT JOIN disco_restaurant_admin_list_cache a ON a.restaurant_reference = c.restaurant_reference
       WHERE c.is_disco_native = true
         AND c.archived_at IS NULL
         AND a.restaurant_reference IS NULL
         AND (${q}::text IS NULL OR lower(c.name) LIKE ${q})
       ORDER BY c.name
       LIMIT ${limit}
    `) as Array<{ reference: string; name: string | null; city: string | null; state: string | null; is_live: boolean; cached_at: string | Date | null }>
    return rows.map(r => ({
      reference: r.reference,
      businessName: r.name || '',
      city: r.city,
      state: r.state,
      isLive: !!r.is_live,
      createdDate: r.cached_at == null ? undefined : (r.cached_at instanceof Date ? r.cached_at.toISOString() : String(r.cached_at)),
    }))
  } catch (e) {
    console.error('[admin/native-restaurant-merge] lookup failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

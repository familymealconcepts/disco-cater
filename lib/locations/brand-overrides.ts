/**
 * Hand-set brand data, reviewed by Peter.
 *
 * Brand detection is FM's hyphenated businessNameWithoutSpaces, then
 * longest-common-prefix within one FM group, then this file. The first two
 * cover most cases; this is the escape hatch for the rest, and it is expected
 * to be used — Peter accepted that some brands get set by hand.
 *
 * Seeded from the FM groups that span more than one brand, so the common cases
 * are answered up front rather than discovered one conversion at a time.
 */
import overrides from '../../data/brand-overrides.json'

interface BrandEntry { brand: string; slug: string; refs?: string[]; status?: string }
const ENTRIES = (overrides as { brands: BrandEntry[] }).brands ?? []

const REF_TO_BRAND = new Map<string, string>()
const BRAND_TO_SLUG = new Map<string, string>()
for (const e of ENTRIES) {
  if (e.brand && e.slug) BRAND_TO_SLUG.set(e.brand, e.slug)
  for (const r of e.refs ?? []) REF_TO_BRAND.set(r, e.brand)
}

/** An explicit brand for one restaurant, overriding detection entirely. */
export function brandOverrideFor(restaurantReference: string): string | null {
  return REF_TO_BRAND.get(restaurantReference) ?? null
}

/** The reviewed link slug for a brand, if one is recorded. */
export function brandSlugFor(brand: string): string | null {
  return BRAND_TO_SLUG.get(brand) ?? null
}

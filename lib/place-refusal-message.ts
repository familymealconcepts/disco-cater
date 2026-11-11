// The message a customer sees when placing an order is refused.
//
// Disco's place routes pass FamilyMeal's response body straight through, and FamilyMeal
// states its reason in `description` (RestExceptionHandler: { code, description, label,
// httpResponseCode }) — e.g. "This date isn't available. Please choose another date."
// Reading only `error` / `message` showed every FamilyMeal refusal as the generic
// "error 409". Disco's own routes answer with `error`, which still wins.
export function placeRefusalMessage(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  for (const key of ['error', 'message', 'description'] as const) {
    const v = b[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  if (status === 401 || status === 403) return 'Please sign in again to place your order.'
  return `We could not place your order (error ${status}). Please try again.`
}

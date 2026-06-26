// Shared wrapper for FamilyMeal (FM) API calls. Adds a default 10s timeout via
// AbortController so a slow/hung FM response can't block a serverless function up
// to its maxDuration. Throws "FM request timed out" on timeout; otherwise behaves
// exactly like fetch().
export async function fmFetch(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('FM request timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

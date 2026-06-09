// Simple shared-secret auth for the read-only export endpoints (/api/export/*).
// The key is sent either as the `x-api-key` header or an `api_key` query param,
// and must match DISCO_API_KEY (set in Vercel env vars).
export function validateApiKey(request: Request): boolean {
  const key = request.headers.get('x-api-key') || new URL(request.url).searchParams.get('api_key')
  return !!key && key === process.env.DISCO_API_KEY
}

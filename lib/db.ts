import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

// Lazy Neon client. `neon()` throws if DATABASE_URL is unset, and it would do
// so at *import* time — which crashes `next build`'s page-data collection on
// any environment without the var (local builds, CI). The Proxy defers that to
// the first actual query, so importing this module is always safe. Usage is
// unchanged: tagged template `sql\`...\`` and `sql.query(...)`.

let client: NeonQueryFunction<false, false> | undefined

function getClient(): NeonQueryFunction<false, false> {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — cannot reach the Neon database.')
    }
    client = neon(process.env.DATABASE_URL)
  }
  return client
}

export const sql = new Proxy(function () {} as unknown as NeonQueryFunction<false, false>, {
  apply(_target, _thisArg, args: unknown[]) {
    return (getClient() as unknown as (...a: unknown[]) => unknown)(...args)
  },
  get(_target, prop) {
    const c = getClient() as unknown as Record<string | symbol, unknown>
    const value = c[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
  },
}) as NeonQueryFunction<false, false>

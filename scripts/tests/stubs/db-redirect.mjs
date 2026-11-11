// Redirects every import of lib/db to the test stub. Registered by the guard test
// itself before it imports the route under test.
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const stub = pathToFileURL(path.resolve('scripts/tests/stubs/db-stub.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context)
    if (/\/lib\/db(\.ts)?$/.test(new URL(r.url).pathname)) return { ...r, url: stub }
    return r
  },
})

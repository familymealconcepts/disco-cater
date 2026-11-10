// Disco menu routes must scope through resolveDiscoScopeRef, never require ctx.restaurantReference
// (Pecking House, Peter 2026-11-10). An FM-password session carries restaurantReference '' (resolved
// per request), so `if (!ctx?.restaurantReference)` 404'd every Disco menu page for those logins while
// the menu list, which resolves the scope, still showed the menus and their item counts.
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('route.ts') ? [p] : [] })
const routes = readdirSync('app/api/restaurant').filter(d => d.startsWith('disco-')).flatMap(d => walk(join('app/api/restaurant', d)))
ok(routes.length > 10, 'found the Disco menu routes')
for (const p of routes) {
  const s = readFileSync(p, 'utf8')
  ok(!/if \(!ctx\?\.restaurantReference/.test(s), `${p}: no gate on ctx.restaurantReference`)
  for (const m of s.matchAll(/const (\w+) = await resolveDiscoScopeRef\(ctx\)\n/g)) {
    const after = s.slice(m.index! + m[0].length, m.index! + m[0].length + 200)
    ok(new RegExp(`if \\(!${m[1]}\\)`).test(after) || !/\$\{\s*\w+\s*\}::uuid/.test(after.split('\n')[0]), `${p}: an empty scope is refused before it is used`)
  }
}
console.log(`disco-menu-scope: ALL PASS ${n} assertions`)

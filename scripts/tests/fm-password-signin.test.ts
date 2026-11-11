// Guards for the FamilyMeal-password rule on the restaurant portal (11 Nov 2026).
// Run: npx tsx scripts/tests/fm-password-signin.test.ts
//
// Peter's rule: a restaurant user who signs in with their FamilyMeal password must
// set a Disco Cater password before any part of the portal works; after that only
// the Disco password signs them in. The team's master password keeps working.
//
//   1. The gate: an FM session with no valid clearance gets no portal page (redirect)
//      and no portal API (403 with a reason) — including every FM session from
//      before the rule, and a clearance forged, expired or moved to another email.
//   2. The master password is exempt: an FM session, a MASTER_PASSWORD_LOGIN audit
//      row, a 'master' clearance, and the scope rule never consulted.
//   3. After a Disco password exists, the FM password is refused (401, no session).
//   4. No Disco password yet: the set-password step, no session, the role from
//      FamilyMeal, and no grant written. FM-backed users and SUPER_ADMIN keep FM.
//   5. No FamilyMeal writes: the only FM call on any path is POST /login.
//
// The route runs for real with lib/db redirected to a stub (scripts/tests/stubs) and
// fetch intercepted: nothing reaches Neon or FamilyMeal.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg) }

const MASTER = 'team-master-test-value'
process.env.MASTER_PASSWORD_HASH = createHash('sha256').update(MASTER).digest('hex')

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`
}

// ── Neon + FamilyMeal stand-ins ────────────────────────────────────────────────
interface Scenario {
  grants?: string[]
  cache?: { total: number; native: number }
  account?: { email?: string; password_set_at: string | null; archived_at: string | null } | null
  fm: { status: number; body: Record<string, unknown> }
}
let scenario: Scenario
let statements: string[] = []
let fmCalls: Array<{ method: string; url: string }> = []
let createdRow = false

function sqlHandler(text: string, params: unknown[]): unknown[] {
  const t = text.replace(/\s+/g, ' ').trim()
  statements.push(t)
  if (t.includes('FROM disco_restaurant_location_access')) return (scenario.grants || []).map(ref => ({ ref }))
  if (t.includes('count(*) FILTER (WHERE is_disco_native)')) return [scenario.cache || { total: 0, native: 0 }]
  if (t.startsWith('SELECT password_set_at, archived_at FROM disco_restaurant_accounts')) return scenario.account ? [scenario.account] : []
  if (t.startsWith('INSERT INTO disco_restaurant_accounts')) { createdRow = true; return [] }
  if (t.startsWith('SELECT email, password_set_at, archived_at, restaurant_name, first_name')) {
    if (scenario.account) return [{ email: scenario.account.email || params[0], ...scenario.account, restaurant_name: null, first_name: null }]
    return createdRow ? [{ email: params[0], password_set_at: null, archived_at: null, restaurant_name: null, first_name: 'Pat' }] : []
  }
  if (t.startsWith('SELECT name FROM disco_restaurant_cache')) return [{ name: 'Test Kitchen' }]
  return []
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method || 'GET').toUpperCase()
  if (url.includes('familymeal.com')) {
    fmCalls.push({ method, url })
    if (url.endsWith('/login')) return new Response(JSON.stringify(scenario.fm.body), { status: scenario.fm.status, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const WRITE = /^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE TABLE IF NOT EXISTS disco_admin_audit)/i
function writes() { return statements.filter(s => WRITE.test(s)) }

async function main() {
  await import('./stubs/db-redirect.mjs')
  ;(globalThis as unknown as { __sqlHandler: typeof sqlHandler }).__sqlHandler = sqlHandler
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../../app/api/restaurant-auth/route')
  const { middleware } = await import('../../middleware')
  const { signClearance, verifyClearance, FM_PORTAL_CLEARANCE_COOKIE } = await import('../../lib/fm-portal-clearance')

  async function signIn(email: string, password: string, s: Scenario) {
    scenario = s; statements = []; fmCalls = []; createdRow = false
    const req = new NextRequest('http://localhost:3000/api/restaurant-auth', {
      method: 'POST', body: JSON.stringify({ email, password }), headers: { 'content-type': 'application/json' },
    })
    const res = await POST(req)
    const body = await res.json()
    const setCookies = res.headers.getSetCookie()
    const cookie = (name: string) => {
      const c = setCookies.find(x => x.startsWith(`${name}=`))
      return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null
    }
    return { status: res.status, body, cookie }
  }
  const fmOk = (email: string, role: string, restaurant: string | null) => ({
    status: 200,
    body: { authorization: `Bearer ${fakeJwt({ sub: email, role, restaurant })}`, refreshToken: 'r1', email, firstName: 'Pat', lastName: 'Q', role },
  })

  console.log('\n=== 1. gate: pages and APIs refuse an uncleared FM session ===')
  const userToken = fakeJwt({ sub: 'owner@kitchen.test', role: 'SYSTEM_ADMIN', restaurant: 'r-home' })
  async function mw(path: string, cookies: Record<string, string>) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
    return middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { cookie } }))
  }
  const passes = (r: Response) => r.headers.get('x-middleware-next') === '1'
  await check('FM session from before the rule (no clearance): page redirects to login', async () => {
    const r = await mw('/restaurant/orders', { fm_restaurant_token: userToken })
    ok(!passes(r), 'page was let through')
    ok((r.headers.get('location') || '').includes('/restaurant/login?reason=signin-again'), `location ${r.headers.get('location')}`)
    ok(r.headers.getSetCookie().some(c => c.startsWith('fm_restaurant_token=;') || c.startsWith('fm_restaurant_token=')), 'FM cookie not cleared')
  })
  await check('…and every portal API answers 403 with the reason', async () => {
    for (const p of ['/api/restaurant/orders', '/api/restaurant/disco-menus', '/api/restaurant/tax-rate', '/api/restaurant/meal-packages']) {
      const r = await mw(p, { fm_restaurant_token: userToken })
      eq(r.status, 403, p)
      eq((await r.json()).reason, 'disco-password-required', `${p} reason`)
    }
  })
  await check('the set-password API and the login page stay reachable', async () => {
    ok(passes(await mw('/api/restaurant/accept-invite', { fm_restaurant_token: userToken })), 'accept-invite blocked')
    ok(passes(await mw('/restaurant/login', { fm_restaurant_token: userToken })), 'login page blocked')
    ok(passes(await mw('/restaurant/accept-invite', { fm_restaurant_token: userToken })), 'accept-invite page blocked')
  })
  await check('a clearance for another email, tampered, or expired does not open it', async () => {
    const other = await signClearance('someone-else@kitchen.test', 'fm-backed', 3600)
    const good = (await signClearance('owner@kitchen.test', 'fm-backed', 3600))!
    const [v, body] = good.split('.')
    const tampered = `${v}.${Buffer.from(JSON.stringify({ e: 'owner@kitchen.test', k: 'master', x: 9999999999 })).toString('base64url')}.${good.split('.')[2]}`
    const expired = await signClearance('owner@kitchen.test', 'fm-backed', -10)
    for (const [label, c] of [['other email', other], ['tampered', tampered], ['expired', expired], ['garbage', `${v}.${body}.AAAA`]] as const) {
      const r = await mw('/api/restaurant/orders', { fm_restaurant_token: userToken, [FM_PORTAL_CLEARANCE_COOKIE]: c! })
      eq(r.status, 403, label)
    }
  })
  await check('a valid clearance for the same email passes; a Disco session is unaffected', async () => {
    const c = (await signClearance('owner@kitchen.test', 'fm-backed', 3600))!
    ok(passes(await mw('/restaurant/orders', { fm_restaurant_token: userToken, [FM_PORTAL_CLEARANCE_COOKIE]: c })), 'cleared page blocked')
    ok(passes(await mw('/api/restaurant/orders', { fm_restaurant_token: userToken, [FM_PORTAL_CLEARANCE_COOKIE]: c })), 'cleared API blocked')
    ok(passes(await mw('/restaurant/orders', { disco_restaurant_token: 'opaque' })), 'Disco page blocked')
    ok(passes(await mw('/api/restaurant/orders', { disco_restaurant_token: 'opaque' })), 'Disco API blocked')
  })
  await check('the server-side helpers apply the same gate (not only the edge)', () => {
    const ctx = readFileSync('lib/restaurant-auth-context.ts', 'utf8')
    const ra = readFileSync('lib/restaurant-auth.ts', 'utf8')
    ok(/fmPortalSessionAllowed\(fmToken, fmClaims\)/.test(ctx), 'getRestaurantAuthContext does not gate the FM branch')
    ok(/return \(await verifiedPortalClaims\(token\)\) \? token : null/.test(ra), 'getRestaurantToken does not gate')
    ok(/async function decodeJwt[\s\S]{0,120}verifiedPortalClaims\(token\)/.test(ra), 'decodeJwt does not gate')
  })

  console.log('\n=== 2. the master password is exempt ===')
  await check('master password: FM session, master clearance, audited, scope never consulted', async () => {
    const r = await signIn('owner@kitchen.test', MASTER, { fm: fmOk('owner@kitchen.test', 'SYSTEM_ADMIN', 'r-home'), account: { password_set_at: '2026-10-01', archived_at: null }, cache: { total: 1, native: 1 } })
    eq(r.status, 200, 'status')
    ok(r.cookie('fm_restaurant_token'), 'no FM session issued')
    const clr = await verifyClearance(r.cookie(FM_PORTAL_CLEARANCE_COOKIE), 'owner@kitchen.test')
    eq(clr?.kind, 'master', 'clearance kind')
    ok(statements.some(s => s.startsWith('INSERT INTO disco_admin_audit') && s.includes("'MASTER_PASSWORD_LOGIN'")), 'no MASTER_PASSWORD_LOGIN row')
    ok(!statements.some(s => s.includes('disco_restaurant_accounts')), 'master path consulted the Disco account')
  })
  await check('a FamilyMeal SUPER_ADMIN (the team) keeps an FM session', async () => {
    const r = await signIn('team@familymeal.test', 'their-own', { fm: fmOk('team@familymeal.test', 'SUPER_ADMIN', null) })
    eq(r.status, 200, 'status')
    eq((await verifyClearance(r.cookie(FM_PORTAL_CLEARANCE_COOKIE), 'team@familymeal.test'))?.kind, 'super-admin', 'clearance')
  })

  console.log('\n=== 3. FM password refused once a Disco password exists ===')
  await check('System Admin, all locations on Disco, Disco password set: 401, no session', async () => {
    const r = await signIn('owner@kitchen.test', 'fm-pw', { fm: fmOk('owner@kitchen.test', 'SYSTEM_ADMIN', 'r-home'), grants: ['r-home', 'r-two'], cache: { total: 2, native: 2 }, account: { password_set_at: '2026-10-14', archived_at: null } })
    eq(r.status, 401, 'status')
    eq(r.body.reason, 'use-disco-password', 'reason')
    ok(/Disco Cater password/.test(r.body.error) && /Forgot password/.test(r.body.error), 'message does not point at the Disco password / reset')
    ok(!r.cookie('fm_restaurant_token'), 'FM session issued')
    ok(!r.cookie(FM_PORTAL_CLEARANCE_COOKIE), 'clearance issued')
    eq(writes().filter(s => !s.startsWith('INSERT INTO disco_admin_audit')).length, 0, 'wrote something other than the audit row')
  })
  await check('removed (archived) Disco account: 403, no session', async () => {
    const r = await signIn('gone@kitchen.test', 'fm-pw', { fm: fmOk('gone@kitchen.test', 'ADMIN', 'r-home'), cache: { total: 1, native: 1 }, account: { password_set_at: null, archived_at: '2026-10-20' } })
    eq(r.status, 403, 'status'); ok(!r.cookie('fm_restaurant_token'), 'FM session issued')
  })

  console.log('\n=== 4. no Disco password yet: set-password step only ===')
  await check('no account row: set-password token, no session, FM role, no grant written', async () => {
    const r = await signIn('New@Kitchen.test', 'fm-pw', { fm: fmOk('new@kitchen.test', 'ADMIN', 'r-home'), cache: { total: 1, native: 1 }, account: null })
    eq(r.status, 200, 'status')
    eq(r.body.needsPasswordSetup, true, 'needsPasswordSetup')
    ok(typeof r.body.setupToken === 'string' && r.body.setupToken.length > 20, 'no setup token')
    ok(!r.cookie('fm_restaurant_token') && !r.cookie('disco_restaurant_token'), 'a session was issued')
    const ins = statements.find(s => s.startsWith('INSERT INTO disco_restaurant_accounts'))
    ok(ins, 'no account row created')
    ok(!statements.some(s => /disco_restaurant_location_access/.test(s) && WRITE.test(s)), 'a grant was written')
    ok(statements.some(s => s.startsWith('UPDATE disco_restaurant_accounts SET invite_token')), 'no one-time token stored')
  })
  await check('account row, no password (System Admin, several locations): token, no session, no grant change', async () => {
    const r = await signIn('sa@kitchen.test', 'fm-pw', { fm: fmOk('sa@kitchen.test', 'SYSTEM_ADMIN', 'r-1'), grants: ['r-1', 'r-2', 'r-3'], cache: { total: 3, native: 3 }, account: { email: 'sa@kitchen.test', password_set_at: null, archived_at: null } })
    eq(r.body.needsPasswordSetup, true, 'needsPasswordSetup')
    ok(!r.cookie('fm_restaurant_token'), 'FM session issued')
    ok(!statements.some(s => /disco_restaurant_location_access/.test(s) && WRITE.test(s)), 'a grant was written')
    ok(!statements.some(s => /UPDATE disco_restaurant_accounts SET[^]*role/.test(s)), 'role changed')
  })
  await check('restaurants still on FamilyMeal: FM session as today, fm-backed clearance', async () => {
    const r = await signIn('fmuser@kitchen.test', 'fm-pw', { fm: fmOk('fmuser@kitchen.test', 'ADMIN', 'r-fm'), cache: { total: 1, native: 0 }, account: null })
    eq(r.status, 200, 'status')
    ok(r.cookie('fm_restaurant_token'), 'no FM session')
    eq((await verifyClearance(r.cookie(FM_PORTAL_CLEARANCE_COOKIE), 'fmuser@kitchen.test'))?.kind, 'fm-backed', 'clearance')
  })
  await check('FamilyMeal refuses the password: its error, no session, no Disco reads', async () => {
    const r = await signIn('x@kitchen.test', 'wrong', { fm: { status: 401, body: { message: 'Bad credentials' } } })
    eq(r.status, 401, 'status'); ok(!r.cookie('fm_restaurant_token'), 'session'); eq(statements.length, 0, 'queries')
  })
  await check('the login page shows the set-password step for the FamilyMeal sign-in too', () => {
    const src = readFileSync('app/(restaurant)/restaurant/login/page.tsx', 'utf8')
    ok(/if \(data\.needsPasswordSetup\) \{\s*setSetup/.test(src), 'login page ignores needsPasswordSetup from /api/restaurant-auth')
  })

  console.log('\n=== 5. no FamilyMeal writes ===')
  // fmCalls is reset per sign-in; run one of each outcome and collect them all.
  const all: Array<{ method: string; url: string }> = []
  for (const s of [
    { fm: fmOk('a@k.test', 'ADMIN', 'r'), cache: { total: 1, native: 1 }, account: null },
    { fm: fmOk('a@k.test', 'ADMIN', 'r'), cache: { total: 1, native: 1 }, account: { password_set_at: '2026-01-01', archived_at: null } },
    { fm: fmOk('a@k.test', 'ADMIN', 'r'), cache: { total: 1, native: 0 }, account: null },
  ] as Scenario[]) { await signIn('a@k.test', 'fm-pw', s); all.push(...fmCalls) }
  await signIn('a@k.test', MASTER, { fm: fmOk('a@k.test', 'ADMIN', 'r') }); all.push(...fmCalls)
  await check('…all four outcomes: only POST /login reached FamilyMeal', () => {
    ok(all.length >= 4, `expected FM calls, saw ${all.length}`)
    for (const c of all) ok(c.method === 'POST' && c.url.endsWith('/login'), `FM call ${c.method} ${c.url}`)
  })
  await check('the new modules never call FamilyMeal with a write method', () => {
    for (const f of ['lib/fm-portal-clearance.ts', 'lib/fm-login-scope.ts', 'lib/fm-portal-gate.ts']) {
      const src = readFileSync(f, 'utf8')
      ok(!/fetch\(/.test(src), `${f} calls fetch`)
    }
    const route = readFileSync('app/api/restaurant-auth/route.ts', 'utf8')
    ok(!/method:\s*'(PUT|PATCH|DELETE)'/.test(route), 'restaurant-auth route uses a write method')
    eq((route.match(/fmFetch\(/g) || []).length, 1, 'restaurant-auth makes more than its one FM /login call')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })

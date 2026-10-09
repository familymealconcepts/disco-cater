#!/usr/bin/env node
// ── MARKETPLACE SWITCH GUARD ────────────────────────────────────────────────
// Fails if any file other than lib/marketplace-switch.ts can turn the
// marketplace switch (disco_restaurant_overrides.visible) ON, or writes the
// test-account flag (disco_restaurant_overrides.is_test).
//
// WHY A GUARD AND NOT A CONVENTION. Before lib/marketplace-switch.ts existed,
// nine separate paths wrote `visible` — admin PATCH, bulk tool, go-live, portal
// toggle, location block, clone, onboarding and two scripts — each with its own
// upsert. A test restaurant can only be kept off the marketplace if EVERY one of
// them asks the same question first, and the next path someone adds will not
// know to. So the rule is enforced on the source, not remembered.
//
// THE RULE:
//   • A write of `visible` outside the helper must be the literal `false`. That
//     keeps insert-time defaults in create routes (a new row starts hidden)
//     legal, and makes everything else — `true`, `${expr}`, EXCLUDED.visible, a
//     subquery — a failure.
//   • A write of `is_test` is allowed only in the helper and in the location
//     clone (which copies the source's flag onto the duplicate). No portal or
//     onboarding route may write it.
//
// HOW IT READS THE SOURCE. It finds every `INSERT INTO disco_restaurant_overrides`
// and `UPDATE disco_restaurant_overrides`, takes the statement up to the end of
// its template literal (or `;` in a .sql file), strips `--` comments, and then
// maps the INSERT column list onto each VALUES tuple positionally and reads
// every `col = expr` in a SET / DO UPDATE SET clause. An INSERT ... SELECT that
// names either column is a failure, because its value cannot be read.
//
// Plain Node, no dependencies, no database. Exit 1 on any violation.
//
//   node scripts/tests/marketplace-switch-guard.test.mjs            # this checkout
//   node scripts/tests/marketplace-switch-guard.test.mjs --root DIR # any tree (control runs)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const rootArg = process.argv.indexOf('--root')
const ROOT = rootArg > -1 ? process.argv[rootArg + 1] : join(HERE, '..', '..')

const HELPER = 'lib/marketplace-switch.ts'
const IS_TEST_WRITERS = new Set([HELPER, 'lib/locations/clone-restaurant.ts'])
const SELF = 'scripts/tests/marketplace-switch-guard.test.mjs'
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'test-results', 'playwright-report'])
const EXTS = /\.(ts|tsx|js|mjs|cjs|sql)$/

// ── Lexing helpers ──────────────────────────────────────────────────────────

// From `start` (inside a template literal), return the index of the backtick
// that closes it, skipping over nested ${ ... } expressions (which may hold
// their own strings and templates).
function endOfTemplate(src, start) {
  let i = start
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '`') return i
    if (ch === '$' && src[i + 1] === '{') { i = endOfExpr(src, i + 2); continue }
    i++
  }
  return src.length
}

// From just inside `${`, return the index after its matching `}`.
function endOfExpr(src, start) {
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '`') { i = endOfTemplate(src, i + 1) + 1; continue }
    if (ch === '"' || ch === "'") {
      const q = ch; i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      i++; continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return i
}

// Split on commas at nesting depth 0, treating ( ), ${ }, [ ] and quotes as nesting.
function splitTopLevel(s) {
  const out = []
  let depth = 0, cur = '', q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { cur += ch; if (ch === '\\') { cur += s[++i] ?? '' } else if (ch === q) q = null; continue }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// Index of the paren that closes the one opening at `open`.
function closeParen(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

function stripSqlComments(s) {
  return s.split('\n').map(line => {
    const k = line.indexOf('--')
    return k === -1 ? line : line.slice(0, k)
  }).join('\n')
}

// Read `col = expr` assignments out of a SET clause body.
function readAssignments(setBody) {
  // Cut at the first WHERE / RETURNING / FROM that is not nested.
  let depth = 0, end = setBody.length
  for (let i = 0; i < setBody.length; i++) {
    const ch = setBody[i]
    if (ch === '(' || ch === '{') depth++
    else if (ch === ')' || ch === '}') depth--
    else if (depth === 0 && /\s/.test(ch)) {
      const m = setBody.slice(i).match(/^\s+(WHERE|RETURNING|FROM)\b/i)
      if (m) { end = i; break }
    }
  }
  return splitTopLevel(setBody.slice(0, end)).map(a => {
    const m = a.match(/^\s*(?:"?[a-z_]+"?\.)?"?([a-z_]+)"?\s*=\s*([\s\S]*)$/i)
    return m ? { col: m[1].toLowerCase(), expr: m[2].trim() } : null
  }).filter(Boolean)
}

// ── Statement analysis ──────────────────────────────────────────────────────

// Returns [{ col, expr, where }] for every write of a watched column.
export function analyzeStatement(stmt) {
  const s = stripSqlComments(stmt)
  const writes = []
  const watched = c => c === 'visible' || c === 'is_test'

  const ins = s.match(/INSERT\s+INTO\s+disco_restaurant_overrides\b(?:\s+AS\s+\w+)?\s*\(/i)
  if (ins) {
    const open = ins.index + ins[0].length - 1
    const close = closeParen(s, open)
    const cols = splitTopLevel(s.slice(open + 1, close)).map(c => c.replace(/"/g, '').toLowerCase())
    const rest = s.slice(close + 1)
    const vm = rest.match(/^\s*VALUES\b/i)
    if (vm) {
      // One or more tuples, then optionally ON CONFLICT.
      let i = vm[0].length
      while (true) {
        const o = rest.indexOf('(', i)
        if (o === -1) break
        const between = rest.slice(i, o)
        if (between.trim() && between.trim() !== ',') break
        const c = closeParen(rest, o)
        const vals = splitTopLevel(rest.slice(o + 1, c))
        cols.forEach((col, k) => { if (watched(col)) writes.push({ col, expr: (vals[k] ?? '<missing>').trim(), where: 'INSERT VALUES' }) })
        i = c + 1
      }
    } else {
      cols.forEach(col => { if (watched(col)) writes.push({ col, expr: '<INSERT ... SELECT>', where: 'INSERT SELECT' }) })
    }
    const du = s.match(/DO\s+UPDATE\s+SET\b/i)
    if (du) {
      for (const a of readAssignments(s.slice(du.index + du[0].length))) {
        if (watched(a.col)) writes.push({ col: a.col, expr: a.expr, where: 'ON CONFLICT DO UPDATE' })
      }
    }
  }

  const upd = s.match(/UPDATE\s+disco_restaurant_overrides\b(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b/i)
  if (upd) {
    for (const a of readAssignments(s.slice(upd.index + upd[0].length))) {
      if (watched(a.col)) writes.push({ col: a.col, expr: a.expr, where: 'UPDATE SET' })
    }
  }
  return writes
}

export function violationsFor(file, writes) {
  const out = []
  for (const w of writes) {
    if (w.col === 'visible' && file !== HELPER && w.expr.toLowerCase() !== 'false') {
      out.push(`visible written as \`${w.expr.replace(/\s+/g, ' ').slice(0, 80)}\` (${w.where}) — route it through setMarketplaceVisible() in ${HELPER}`)
    }
    if (w.col === 'is_test' && !IS_TEST_WRITERS.has(file)) {
      out.push(`is_test written (${w.where}) — only ${[...IS_TEST_WRITERS].join(' / ')} may write the test flag`)
    }
  }
  return out
}

// Every write statement on the overrides table in one file's text.
export function statementsIn(src, isSql) {
  const out = []
  const re = /(INSERT\s+INTO|UPDATE)\s+disco_restaurant_overrides\b/gi
  let m
  while ((m = re.exec(src))) {
    const start = m.index
    let end
    if (isSql) { end = src.indexOf(';', start); if (end === -1) end = src.length }
    else end = endOfTemplate(src, start)
    out.push({ start, text: src.slice(start, end) })
    re.lastIndex = Math.max(re.lastIndex, start + 1)
  }
  return out
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length }

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (EXTS.test(name)) acc.push(p)
  }
  return acc
}

// ── Self-test: the analyser must flag the shapes that actually existed ──────
// Each of these is a real pre-helper write, copied verbatim in shape. If the
// parser regresses (say, stops reading multi-line column lists), these fail
// before the tree scan can pass vacuously.
function selfTest() {
  const must = [
    ['bulk upsert true', "INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)\n VALUES (${ref}, true, NOW())\n ON CONFLICT (restaurant_reference) DO UPDATE SET visible = true, updated_at = NOW()"],
    ['PATCH EXCLUDED.visible', "INSERT INTO disco_restaurant_overrides (restaurant_reference, is_premium, visible, order_url, updated_at)\n VALUES (${restaurantReference}, ${isPremium}, false, ${orderUrl}, NOW())\n ON CONFLICT (restaurant_reference) DO UPDATE\n SET is_premium = EXCLUDED.is_premium,\n visible = EXCLUDED.visible,\n order_url = EXCLUDED.order_url"],
    ['onboarding expression', "INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, is_premium, stripe_connected)\n VALUES (${ref}, ${joinedMarketplace}, false, ${stripeConnected})\n ON CONFLICT (restaurant_reference) DO UPDATE SET visible = ${joinedMarketplace}, stripe_connected = ${stripeConnected}"],
    ['clone multi-line true', "INSERT INTO disco_restaurant_overrides (\n restaurant_reference, visible,\n tax_rates\n -- comment, with a comma; and a semicolon\n ) VALUES (\n ${newRef}, true,\n ${s.tax_rates ? JSON.stringify(s.tax_rates) : null}::jsonb\n )\n ON CONFLICT (restaurant_reference) DO NOTHING"],
    ['multi-row VALUES', "INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_connected, visible) VALUES\n (${a}, true, false), (${b}, true, true)"],
    ['plain UPDATE', "UPDATE disco_restaurant_overrides SET visible = ${v}, updated_at = NOW() WHERE restaurant_reference = ${ref}"],
    ['aliased UPDATE', "UPDATE disco_restaurant_overrides o SET visible = true WHERE o.restaurant_reference = ${ref}"],
    ['INSERT SELECT', "INSERT INTO disco_restaurant_overrides (restaurant_reference, visible) SELECT ref, true FROM x"],
    ['is_test from a route', "UPDATE disco_restaurant_overrides SET is_test = ${body.isTest} WHERE restaurant_reference = ${ref}"],
  ]
  const mustNot = [
    ['create-route default', "INSERT INTO disco_restaurant_overrides\n (restaurant_reference, visible, is_premium, stripe_connected)\n VALUES (${reference}, false, false, false)\n ON CONFLICT (restaurant_reference) DO NOTHING"],
    ['turn-off upsert', "INSERT INTO disco_restaurant_overrides (restaurant_reference, visible) VALUES (${r}, false) ON CONFLICT (restaurant_reference) DO UPDATE SET visible = false"],
    ['WHERE reads visible', "UPDATE disco_restaurant_overrides SET stripe_checked_at = NOW() WHERE visible = true AND restaurant_reference = ${r}"],
    ['other column only', "INSERT INTO disco_restaurant_overrides (restaurant_reference, online_ordering_enabled) VALUES (${r}, ${on}) ON CONFLICT (restaurant_reference) DO UPDATE SET online_ordering_enabled = EXCLUDED.online_ordering_enabled"],
  ]
  const fails = []
  for (const [name, stmt] of must) {
    if (violationsFor('app/api/somewhere/route.ts', analyzeStatement(stmt)).length === 0) fails.push(`self-test: should flag "${name}" but did not`)
  }
  for (const [name, stmt] of mustNot) {
    const v = violationsFor('app/api/somewhere/route.ts', analyzeStatement(stmt))
    if (v.length) fails.push(`self-test: should allow "${name}" but flagged: ${v.join('; ')}`)
  }
  // And the helper itself is exempt for visible.
  if (violationsFor(HELPER, analyzeStatement(must[0][1])).length) fails.push('self-test: helper should be exempt for visible')
  return fails
}

// ── Main ────────────────────────────────────────────────────────────────────
const failures = selfTest()
let scanned = 0, statements = 0
for (const abs of walk(ROOT, [])) {
  const file = relative(ROOT, abs).split(sep).join('/')
  if (file === SELF) continue
  const src = readFileSync(abs, 'utf8')
  if (!src.includes('disco_restaurant_overrides')) continue
  scanned++
  for (const st of statementsIn(src, file.endsWith('.sql'))) {
    statements++
    for (const v of violationsFor(file, analyzeStatement(st.text))) failures.push(`${file}:${lineOf(src, st.start)}  ${v}`)
  }
}

if (failures.length) {
  console.error(`marketplace-switch guard: ${failures.length} violation(s)\n`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`marketplace-switch guard: OK — ${statements} write statement(s) on disco_restaurant_overrides across ${scanned} file(s); none turns the switch on outside ${HELPER}.`)

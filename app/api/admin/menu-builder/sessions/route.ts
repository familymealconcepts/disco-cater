// Menu Builder sessions: list (for review) and start one. Starting validates
// the locations (Disco-native, not archived) and, for an update, finds the
// menu by name at every location; the first turn (reading the files, asking
// questions) then runs in the background and the page polls the session.
import { NextRequest, NextResponse, after } from 'next/server'
import { sql } from '../../../../../lib/db'
import { requireMenuBuilderAccess } from '../../../../../lib/menu-builder/access'
import { ensureMenuBuilderTables, scrubSensitive } from '../../../../../lib/menu-builder/store'
import { runIngest } from '../../../../../lib/menu-builder/engine'
import { isOurUpload, type Upload } from '../../../../../lib/menu-builder/files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 800

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  await ensureMenuBuilderTables()
  const sessions = await sql`
    SELECT reference, actor_email, mode, restaurant_names, target_menu_name, status, cost_usd,
           jsonb_array_length(messages) AS messages, jsonb_array_length(files) AS files, created_at, updated_at
      FROM disco_menu_builder_sessions ORDER BY id DESC LIMIT 200`
  return NextResponse.json({ sessions })
}

export async function POST(req: NextRequest) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  await ensureMenuBuilderTables()
  const body = await req.json().catch(() => ({}))
  const mode = body?.mode === 'update' ? 'update' : 'new'
  const refs: string[] = [...new Set((Array.isArray(body?.restaurantRefs) ? body.restaurantRefs : []).map(String))] as string[]
  if (!refs.length || refs.some(r => !UUID.test(r))) return NextResponse.json({ error: 'Pick at least one location.' }, { status: 400 })
  if (refs.length > 25) return NextResponse.json({ error: 'At most 25 locations per session.' }, { status: 400 })
  const rows = (await sql`
    SELECT restaurant_reference::text AS ref, name FROM disco_restaurant_cache
     WHERE restaurant_reference::text = ANY(${refs}::text[]) AND is_disco_native = true AND archived_at IS NULL`) as { ref: string; name: string }[]
  const names = refs.map(r => rows.find(x => x.ref === r)?.name)
  if (names.some(n => !n)) return NextResponse.json({ error: 'Menu Builder only works on active Disco-native locations.' }, { status: 400 })

  let targetName: string | null = null
  let targetRefs: Record<string, string> | null = null
  if (mode === 'update') {
    const tm = String(body?.targetMenuRef || '')
    if (!UUID.test(tm)) return NextResponse.json({ error: 'Pick the menu to update.' }, { status: 400 })
    const t = (await sql`SELECT name, restaurant_reference::text AS rest FROM disco_menus WHERE reference = ${tm}::uuid`) as { name: string; rest: string }[]
    if (!t[0] || t[0].rest !== refs[0]) return NextResponse.json({ error: 'That menu is not at the first location.' }, { status: 400 })
    targetName = t[0].name
    targetRefs = { [refs[0]]: tm }
    for (const r of refs.slice(1)) {
      const m = (await sql`SELECT reference::text AS reference FROM disco_menus WHERE restaurant_reference = ${r}::uuid AND name = ${targetName}
                            ORDER BY archived ASC, updated_at DESC NULLS LAST LIMIT 1`) as { reference: string }[]
      if (!m[0]) return NextResponse.json({ error: `${names[refs.indexOf(r)]} has no menu named "${targetName}".` }, { status: 400 })
      targetRefs[r] = m[0].reference
    }
  }

  const uploads: Upload[] = (Array.isArray(body?.uploads) ? body.uploads : [])
    .map((u: Record<string, unknown>) => ({ name: String(u?.name || 'file'), url: String(u?.url || ''), size: Number(u?.size) || 0, contentType: String(u?.contentType || '') }))
    .filter((u: Upload) => isOurUpload(u.url))
    .slice(0, 200)
  const sheetLinks: string[] = (Array.isArray(body?.sheetLinks) ? body.sheetLinks : []).map(String).filter((l: string) => /docs\.google\.com\/spreadsheets\/d\//.test(l)).slice(0, 20)
  const prompt = scrubSensitive(String(body?.prompt || '').trim().slice(0, 20_000))
  if (!uploads.length && !sheetLinks.length && !prompt) return NextResponse.json({ error: 'Add files, a Google Sheet link, or instructions.' }, { status: 400 })

  const [s] = (await sql`
    INSERT INTO disco_menu_builder_sessions (actor_email, mode, restaurant_refs, restaurant_names, target_menu_name, target_menu_refs, status, status_note, files, messages)
    VALUES (${access.email}, ${mode}, ${JSON.stringify(refs)}::jsonb, ${JSON.stringify(names)}::jsonb, ${targetName}, ${targetRefs ? JSON.stringify(targetRefs) : null}::jsonb,
            'working', 'Starting…',
            ${JSON.stringify([...uploads.map(u => ({ name: u.name, type: (u.name.split('.').pop() || '').toLowerCase(), size: u.size })), ...sheetLinks.map(l => ({ name: l, type: 'google-sheet', size: 0 }))])}::jsonb,
            ${JSON.stringify([{ role: 'user', text: prompt || '(no instructions — use the files)', at: new Date().toISOString() }])}::jsonb)
    RETURNING reference::text AS reference`) as { reference: string }[]
  after(() => runIngest(s.reference, uploads, sheetLinks))
  return NextResponse.json({ reference: s.reference })
}

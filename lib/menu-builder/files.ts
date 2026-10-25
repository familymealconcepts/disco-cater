// Menu Builder file reading. Turns whatever was uploaded into what Claude can
// read: PDFs go as documents, photos (incl. HEIC) as images, every tab of every
// spreadsheet (xlsx / csv / Google Sheet link) and Word documents as text,
// ZIPs are opened and each entry read the same way.
//
// The raw uploads live in Blob only until this has read them — the caller
// deletes them straight after (deleteUploads). Item photos the bot keeps are
// re-hosted content-addressed under menu-item-images/, like imported images.

import { createHash } from 'crypto'
import sharp from 'sharp'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { put, del } from '@vercel/blob'
import type { FileNote } from './store'

export type Upload = { name: string; url: string; contentType?: string; size?: number }
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string }

export type Photo = { name: string; jpeg: Buffer }
export type Ingested = { blocks: ContentBlock[]; notes: FileNote[]; photos: Photo[] }

const MAX_FILE = 50 * 1024 * 1024
const MAX_TEXT = 400_000
const MAX_VISUAL_IMAGES = 90
const UPLOAD_PREFIX = '/menu-builder-uploads/'

/** Only our own Blob uploads are ever fetched (never an arbitrary URL). */
export function isOurUpload(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.endsWith('.public.blob.vercel-storage.com') && u.pathname.startsWith(UPLOAD_PREFIX)
  } catch { return false }
}

const ext = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '')
const base = (name: string) => name.split('/').pop() || name

async function toJpeg(buf: Buffer, isHeic: boolean, maxEdge: number): Promise<Buffer> {
  let src = buf
  if (isHeic) {
    const convert = (await import('heic-convert')).default
    src = Buffer.from(new Uint8Array(await convert({ buffer: buf, format: "JPEG", quality: 0.9 }) as ArrayBuffer))
  }
  return sharp(src).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
}

function sheetText(label: string, wb: ExcelJS.Workbook): string {
  const parts: string[] = []
  wb.eachSheet(ws => {
    const rows: string[] = []
    ws.eachRow({ includeEmpty: false }, row => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, c => { cells.push(String(c.text ?? '').replace(/\s+/g, ' ').trim()) })
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      if (cells.some(Boolean)) rows.push(cells.join(' | '))
    })
    parts.push(`=== ${label} — tab "${ws.name}" (${rows.length} rows) ===\n${rows.join('\n') || '(empty tab)'}`)
  })
  return parts.join('\n\n')
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[… cut off at ${MAX_TEXT} characters]` : s)

async function readOne(name: string, buf: Buffer, out: Ingested, depth: number): Promise<void> {
  const e = ext(name)
  const note: FileNote = { name, type: e || 'unknown', size: buf.length }
  try {
    if (buf.length > MAX_FILE) { note.note = 'too large (over 50 MB) — not read'; return }
    if (e === 'pdf') {
      out.blocks.push({ type: 'text', text: `File: ${name} (PDF)` })
      out.blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: name })
    } else if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp'].includes(e)) {
      const jpeg = await toJpeg(buf, e === 'heic' || e === 'heif', 1568)
      out.photos.push({ name: base(name), jpeg })
    } else if (e === 'zip') {
      if (depth > 1) { note.note = 'zip inside a zip inside a zip — not opened'; return }
      const zip = await JSZip.loadAsync(buf)
      const entries = Object.values(zip.files).filter(f => !f.dir && !f.name.startsWith('__MACOSX/') && !base(f.name).startsWith('.'))
      note.note = `${entries.length} files inside`
      for (const f of entries) await readOne(f.name, await f.async('nodebuffer'), out, depth + 1)
    } else if (e === 'xlsx' || e === 'xlsm') {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as unknown as ArrayBuffer)
      note.note = `${wb.worksheets.length} tab(s): ${wb.worksheets.map(w => w.name).join(', ')}`
      out.blocks.push({ type: 'text', text: clip(sheetText(`Spreadsheet ${name}`, wb)) })
    } else if (e === 'csv' || e === 'tsv' || e === 'txt' || e === 'md') {
      out.blocks.push({ type: 'text', text: clip(`=== ${name} ===\n${buf.toString('utf8')}`) })
    } else if (e === 'docx') {
      const r = await mammoth.extractRawText({ buffer: buf })
      out.blocks.push({ type: 'text', text: clip(`=== Word document ${name} ===\n${r.value}`) })
    } else if (e === 'xls' || e === 'doc') {
      note.note = `old .${e} format — please re-save as .${e}x and upload again`
    } else {
      note.note = 'file type not supported — not read'
    }
  } catch (err) {
    note.note = `could not be read: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    out.notes.push(note)
  }
}

/** A Google Sheet shared by link, every tab, via its own xlsx export. */
async function readGoogleSheet(link: string, out: Ingested): Promise<void> {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(link)?.[1]
  const note: FileNote = { name: link, type: 'google-sheet', size: 0 }
  try {
    if (!id) { note.note = 'not a Google Sheets link'; return }
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow' })
    const ct = res.headers.get('content-type') || ''
    if (!res.ok || ct.includes('text/html')) { note.note = 'could not be opened — share it as "Anyone with the link can view" and try again'; return }
    const buf = Buffer.from(await res.arrayBuffer())
    note.size = buf.length
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    note.note = `${wb.worksheets.length} tab(s): ${wb.worksheets.map(w => w.name).join(', ')}`
    out.blocks.push({ type: 'text', text: clip(sheetText(`Google Sheet ${id}`, wb)) })
  } catch (err) {
    note.note = `could not be read: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    out.notes.push(note)
  }
}

export async function ingest(uploads: Upload[], sheetLinks: string[]): Promise<Ingested> {
  const out: Ingested = { blocks: [], notes: [], photos: [] }
  for (const u of uploads) {
    if (!isOurUpload(u.url)) { out.notes.push({ name: u.name, type: ext(u.name), size: 0, note: 'not an upload from this page — not read' }); continue }
    const res = await fetch(u.url, { cache: 'no-store' })
    if (!res.ok) { out.notes.push({ name: u.name, type: ext(u.name), size: 0, note: `upload missing (${res.status})` }); continue }
    await readOne(u.name, Buffer.from(await res.arrayBuffer()), out, 0)
  }
  for (const l of sheetLinks) await readGoogleSheet(l, out)
  // Photos: the first MAX_VISUAL_IMAGES are shown to the bot (smaller when there are many, to keep cost down); the rest by name.
  const many = out.photos.length > 20
  for (const [i, p] of out.photos.entries()) {
    if (i < MAX_VISUAL_IMAGES) {
      const img = many ? await sharp(p.jpeg).resize({ width: 800, height: 800, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer() : p.jpeg
      out.blocks.push({ type: 'text', text: `Photo file: ${p.name}` })
      out.blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.toString('base64') } })
    }
  }
  if (out.photos.length > MAX_VISUAL_IMAGES) {
    out.blocks.push({ type: 'text', text: `More photo files (names only, not shown): ${out.photos.slice(MAX_VISUAL_IMAGES).map(p => p.name).join(', ')}` })
  }
  return out
}

/** Re-host the photos the bot classed as item photos; content-addressed, like imported item images. */
export async function rehostPhotos(photos: Photo[], keep: Set<string>): Promise<{ name: string; url: string }[]> {
  const out: { name: string; url: string }[] = []
  for (const p of photos) {
    if (!keep.has(p.name.toLowerCase())) continue
    const sha = createHash('sha256').update(p.jpeg).digest('hex')
    const r = await put(`menu-item-images/${sha}.jpg`, p.jpeg, { access: 'public', contentType: 'image/jpeg', allowOverwrite: true, addRandomSuffix: false })
    out.push({ name: p.name, url: r.url })
  }
  return out
}

export async function deleteUploads(uploads: Upload[]): Promise<void> {
  const urls = uploads.map(u => u.url).filter(isOurUpload)
  if (urls.length) await del(urls).catch(e => console.error('[menu-builder] upload cleanup failed:', e instanceof Error ? e.message : e))
}

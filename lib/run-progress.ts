/**
 * Append-only progress log for long conversion runs.
 *
 * The previous runners kept progress in an in-memory map and rewrote the WHOLE
 * JSON file after every restaurant. Two runs overlapped on 2026-09-09 — the
 * first was killed by a tool timeout while still working and the second was
 * started before it had actually exited — and because both had loaded the map
 * at startup, each write clobbered entries the other had made. Hello Halloumi
 * converted successfully at 01:20:18 and vanished from the record, which is how
 * a restaurant ended up in the database with no run that admitted to it.
 *
 * Appending fixes that at the root: a write only ever adds its own line, so a
 * concurrent run cannot erase it. `appendFileSync` with a single trailing
 * newline is atomic enough for line-sized records on a local filesystem, which
 * is what these are.
 *
 * Reading replays the file, last-write-wins per key, so a restaurant retried
 * later reads as its most recent outcome.
 */
import { appendFileSync, existsSync, readFileSync } from 'fs'

export interface ProgressRecord {
  ref: string
  [k: string]: unknown
}

/** Replay the log into a map, last entry per ref winning. */
export function readProgress(path: string): Record<string, ProgressRecord> {
  if (!existsSync(path)) return {}
  const out: Record<string, ProgressRecord> = {}
  let malformed = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t) as ProgressRecord
      if (rec && typeof rec.ref === 'string') out[rec.ref] = rec
      else malformed++
    } catch {
      // A torn final line (killed mid-write) must not take the whole log with
      // it — skip it and keep every complete record before it.
      malformed++
    }
  }
  if (malformed) console.warn(`[run-progress] ${path}: skipped ${malformed} unparseable line(s)`)
  return out
}

/** Append one record. Never rewrites, so a concurrent run cannot clobber it. */
export function appendProgress(path: string, rec: ProgressRecord): void {
  appendFileSync(path, JSON.stringify(rec) + '\n')
}

/**
 * One-time migration: fold an existing `{ref: record}` JSON map into the log,
 * so history from the old runners is not lost when a runner switches over.
 * Idempotent — refs already present in the log are skipped.
 */
export function importLegacyMap(jsonPath: string, logPath: string): number {
  if (!existsSync(jsonPath)) return 0
  let map: Record<string, ProgressRecord>
  try { map = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch { return 0 }
  const already = readProgress(logPath)
  let n = 0
  for (const [ref, rec] of Object.entries(map)) {
    if (already[ref]) continue
    appendProgress(logPath, { ...rec, ref })
    n++
  }
  return n
}

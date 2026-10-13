// What a report was actually built from, written onto the report itself.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Gracious Bakery & Cafe could not reconcile their weekly email against their
// own download, and both were correct. For 1 Sep - 31 Oct 2026 the same
// restaurant produced:
//
//   scheduled email   27 rows   $6,369.00 net   (both locations, by CREATED date)
//   download          23 rows   $5,871.00 net   (one location,  by ORDER date)
//   download          22 rows   $5,320.00 net   (one location,  by CREATED date)
//
// Three different answers, no bug in any of them — different date basis and
// different location scope. The CSV said none of that: it emitted a column
// header, the rows, and a TOTAL line, and nothing else. Two files with
// different totals and no way to tell why is a reconciliation problem whoever
// is right.
//
// Order #900000265 is the case that surfaced it: placed 29 Sep, delivered 7 Oct.
// By created date it belongs to September; by order date, to October. The
// restaurant went looking in October and concluded it was missing.
//
// ── WHY TRAILING, NOT LEADING ───────────────────────────────────────────────
// These files get imported into accounting software, which reads line 1 as the
// column header. Putting metadata at the top would break every existing import.
// The TOTAL row already sits after the data, so a trailing block follows a shape
// consumers of this file have always had to handle.

export interface ProvenanceFacts {
  /** 'created_at' = when the order was placed; 'order_date' = the delivery date. */
  dateField: 'created_at' | 'order_date'
  from: string
  to: string
  /** Report timezone, for scheduled reports whose period boundaries depend on it. */
  timezone?: string | null
  /** Restaurant names covered, in the order the rows use them. */
  locations?: string[]
  /** Saved status filter, if any. Empty/absent means every status. */
  orderStatuses?: string[] | null
  /** Saved fulfilment filter as stored concepts, if any. Empty/absent means all. */
  deliveryTypes?: string[] | null
  rowCount: number
}

const DATE_BASIS: Record<string, string> = {
  created_at: 'Created date (when the order was placed and charged)',
  order_date: 'Order date (the delivery or pickup date)',
}

/**
 * Human-readable lines describing exactly how this report was built.
 * Same text on every format, so a CSV and a PDF of the same window can be laid
 * side by side and the difference read off rather than guessed at.
 */
export function provenanceLines(f: ProvenanceFacts): string[] {
  const out: string[] = []
  out.push(`Dated by: ${DATE_BASIS[f.dateField] ?? f.dateField}`)
  out.push(`Period: ${f.from} to ${f.to}${f.timezone ? ` (${f.timezone})` : ''}`)
  if (f.locations && f.locations.length) {
    out.push(`Locations included (${f.locations.length}): ${f.locations.join('; ')}`)
  }
  const st = (f.orderStatuses ?? []).filter(Boolean)
  out.push(`Order statuses: ${st.length ? st.join(', ') : 'all'}`)
  const dt = (f.deliveryTypes ?? []).filter(Boolean)
  out.push(`Fulfilment types: ${dt.length ? dt.join(', ') : 'all'}`)
  out.push(`Orders in this report: ${f.rowCount}`)
  return out
}

/** The same facts as one line, for a PDF subtitle or an email body. */
export function provenanceSummary(f: ProvenanceFacts): string {
  const basis = f.dateField === 'created_at' ? 'Created date' : 'Order date'
  const locs = f.locations && f.locations.length > 1 ? ` · ${f.locations.length} locations` : ''
  return `${basis} ${f.from} to ${f.to}${f.timezone ? ` (${f.timezone})` : ''}${locs} · ${f.rowCount} order${f.rowCount === 1 ? '' : 's'}`
}

/** CSV rows for the trailing block. Returned as already-escaped single cells. */
export function provenanceCsvRows(f: ProvenanceFacts): string[] {
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return ['', ...provenanceLines(f).map(l => esc(`# ${l}`))]
}

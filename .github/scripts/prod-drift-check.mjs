// Is production running the latest commit on main? Run by
// .github/workflows/prod-drift.yml — OUTSIDE Vercel on purpose, so it still
// works when Vercel is what failed (GitHub not handing a push to Vercel has
// silently left production on old code several times).
//
// Alerts #ops-alerts when production has been behind main for more than 15
// minutes — ONCE, not hourly (Kevin, 2026-10-23: a standing condition posts
// once) — and says so again when it is back in sync. With the bot token
// (secret SLACK_OPS_ALERTS_BOT_TOKEN) the "back in sync" is a reply in the
// alert's own thread; without it, the "Disco Alerts" webhook (secret
// OPS_ALERTS_SLACK_WEBHOOK) is used and it posts top-level.
// NEVER deploys anything.
//
// State lives in ONE open GitHub issue labelled `prod-drift` (the GITHUB_TOKEN
// can write issues; it cannot write repo variables), so "alerted, and when" is
// visible to people too.
//
// TEST MODE (workflow_dispatch input pretend_live_sha): pretends production runs
// that commit, ignores the 15-minute wait and the hourly limit, prefixes the
// message [TEST], and does not read or write the state issue. Production is not
// touched either way — this script only reads /api/version.

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY, SLACK_WEBHOOK, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID = 'C0C21FDU8KT',
  PROD_URL = 'https://www.discocater.com',
  PRETEND_LIVE_SHA = '', MAIN_SHA_OVERRIDE = '',
} = process.env
const TEST = !!PRETEND_LIVE_SHA.trim()
const BEHIND_ALERT_MIN = 15
const LABEL = 'prod-drift'
const api = 'https://api.github.com'
const now = Date.now()

async function gh(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
  })
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${res.status}`)
  return res.status === 204 ? null : res.json()
}

async function liveSha() {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${PROD_URL}/api/version?t=${now}`, { headers: { 'Cache-Control': 'no-cache' } })
      if (res.ok) { const j = await res.json(); if (j?.sha && j.sha !== 'unknown') return j.sha }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 5000))
  }
  return null
}

/** Post to #ops-alerts; returns the message ts when the bot token was used, so a reply can thread. */
async function slack(text, threadTs) {
  if (SLACK_BOT_TOKEN) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text, unfurl_links: false, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    })
    const j = await res.json().catch(() => ({}))
    if (j.ok) return j.ts
    console.log(`chat.postMessage failed (${j.error ?? res.status}); trying the webhook`) // never the token
  }
  if (!SLACK_WEBHOOK) { console.log('No webhook configured; would have posted:\n' + text); return null }
  const res = await fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error(`Slack post failed: ${res.status}`) // the status only, never the URL
  return null
}

const fmtAge = ms => { const m = Math.round(ms / 60000); return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h` }

async function stateIssue() {
  const open = await gh(`/repos/${GITHUB_REPOSITORY}/issues?state=open&labels=${LABEL}&per_page=5`)
  return open[0] || null
}
const readState = issue => { const m = /<!-- state:(\{.*?\}) -->/.exec(issue?.body || ''); try { return m ? JSON.parse(m[1]) : {} } catch { return {} } }

/** When main first moved past what production runs: the earliest push to main not contained in live. */
async function behindSince(live, fallback) {
  try {
    const acts = await gh(`/repos/${GITHUB_REPOSITORY}/activity?ref=refs/heads/main&activity_type=push&per_page=50`)
    let earliest = null
    for (const a of acts) { // newest first
      const cmp = await gh(`/repos/${GITHUB_REPOSITORY}/compare/${a.after}...${live}`)
      if (cmp.status === 'ahead' || cmp.status === 'identical') break // live already contains this push
      earliest = Date.parse(a.timestamp)
    }
    if (earliest) return earliest
  } catch (e) { console.log('push-time lookup unavailable, using commit time:', e.message) }
  return fallback
}

async function main() {
  const mainSha = MAIN_SHA_OVERRIDE || (await gh(`/repos/${GITHUB_REPOSITORY}/commits/main`)).sha
  const live = TEST ? PRETEND_LIVE_SHA.trim() : await liveSha()
  const issue = TEST ? null : await stateIssue()
  const state = readState(issue)
  console.log(`main=${mainSha.slice(0, 7)} live=${live ? live.slice(0, 7) : 'unreachable'}${TEST ? ' (TEST)' : ''}`)

  // ── IN SYNC ────────────────────────────────────────────────────────────────
  if (live && live === mainSha) {
    if (issue) {
      if (state.alertedAt) {
        if (state.slackTs) await slack(`:white_check_mark: Production is back in sync (\`${mainSha.slice(0, 7)}\`).`, state.slackTs)
        else await slack(`:white_check_mark: *Production is back in sync with main.* The live site (${PROD_URL}) is running \`${mainSha.slice(0, 7)}\`, the latest commit on main. Behind for about ${fmtAge(now - (state.behindSince || state.alertedAt))}.`)
      }
      await gh(`/repos/${GITHUB_REPOSITORY}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Back in sync at \`${mainSha.slice(0, 7)}\`.` }) })
      await gh(`/repos/${GITHUB_REPOSITORY}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
    }
    console.log('In sync.'); return
  }

  // ── BEHIND (or unreadable) ────────────────────────────────────────────────
  let missing = [], since = now, detail
  if (!live) {
    detail = `${PROD_URL}/api/version did not answer with a commit, so it can't be confirmed that production is running main (\`${mainSha.slice(0, 7)}\`).`
    since = state.behindSince || now
  } else {
    const cmp = await gh(`/repos/${GITHUB_REPOSITORY}/compare/${live}...${mainSha}`).catch(() => null)
    if (cmp && cmp.status === 'ahead') {
      missing = cmp.commits
      since = await behindSince(live, Date.parse(missing[0]?.commit?.committer?.date || new Date(now).toISOString()))
      const list = missing.slice(-10).reverse().map(c => `• \`${c.sha.slice(0, 7)}\` ${c.commit.message.split('\n')[0].slice(0, 90)}`).join('\n')
      detail = `Production is running \`${live.slice(0, 7)}\`; main is at \`${mainSha.slice(0, 7)}\`. *${missing.length} commit${missing.length === 1 ? '' : 's'} not live:*\n${list}${missing.length > 10 ? `\n…and ${missing.length - 10} older` : ''}`
    } else {
      detail = `Production is running \`${live.slice(0, 7)}\`, which is not an earlier commit on main (main is \`${mainSha.slice(0, 7)}\`). Someone may have deployed unpushed code from the Vercel CLI.`
      since = state.behindSince || now
    }
  }
  const age = now - since
  console.log(detail.replace(/\n/g, ' | '), `| behind ${fmtAge(age)}`)

  // No push time to measure from (unreadable, or not a commit on main): note
  // when this was first seen, so the 15-minute rule can apply next run.
  if (!TEST && !state.behindSince && (!live || !missing.length)) {
    await saveState(issue, detail, { behindSince: since })
    console.log('First seen now; recorded. No alert yet.'); return
  }

  if (!TEST && age < BEHIND_ALERT_MIN * 60000) { console.log(`Under ${BEHIND_ALERT_MIN} min — a normal deploy may still be running. No alert.`); return }
  if (!TEST && state.alertedAt) { console.log('Already alerted for this drift — not repeating.'); return }

  const text = `${TEST ? '*[TEST — nothing is wrong]* ' : ''}:warning: *Production is behind main* (${fmtAge(age)}). ${detail}\n` +
    `Nothing was deployed automatically. Usually GitHub did not hand the push to Vercel: redeploy main from Vercel, or push an empty commit.`
  const ts = await slack(text)
  if (TEST) { console.log('Test alert posted.'); return }

  await saveState(issue, detail, { behindSince: since, alertedAt: now, ...(ts ? { slackTs: ts } : {}) })
  console.log('Alert posted.')
}

async function saveState(issue, detail, st) {
  const body = `Production is behind main. Updated by .github/workflows/prod-drift.yml; closed automatically when back in sync.\n\n${detail}\n\n<!-- state:${JSON.stringify(st)} -->`
  if (issue) await gh(`/repos/${GITHUB_REPOSITORY}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  else await gh(`/repos/${GITHUB_REPOSITORY}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Production is behind main', body, labels: [LABEL] }) })
}

main().catch(e => { console.error(e.message); process.exit(1) })

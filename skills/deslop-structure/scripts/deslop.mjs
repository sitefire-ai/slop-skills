#!/usr/bin/env node
// The deslop-structure run engine. No dependencies: Node 18+ standard library and built-in fetch.
// Three jobs: call the Slop API, choose the next step of a run, render report.html from run.json.
// Usage: node deslop.mjs <command> [options]. Run `node deslop.mjs help` for the commands.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

const DEFAULT_GOAL = 0.2
const API_DEFAULT_TARGET = 0.3
const DEFAULT_MAX_ROUNDS = 3

// ---------------------------------------------------------------- run folder

const readRun = (runDir) => JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))

/** Writes run.json and renders report.html from it, so the report always shows the run log. */
function writeRun(runDir, run) {
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(join(runDir, 'report.html'), renderReport(runDir, run))
}

const isUrl = (s) => /^https?:\/\//i.test(s)

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function slugOf(input) {
  const raw = isUrl(input) ? new URL(input).pathname.split('/').filter(Boolean).pop() || new URL(input).hostname : basename(input, extname(input))
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'post'
}

/** Starts a Run: makes its folder, copies the original, writes run.json. */
export function init({ input, goal = DEFAULT_GOAL, maxRounds = DEFAULT_MAX_ROUNDS, interactive = true, autoPath = false, scoreOnly = false, runsDir = 'deslop-runs', now = new Date() }) {
  const kind = isUrl(input) ? 'url' : 'file'
  if (kind === 'file' && !existsSync(input)) throw new Error(`No file at ${input}.`)
  const name = slugOf(input)
  const runDir = resolve(runsDir, `${stamp(now)}-${name}`)
  mkdirSync(join(runDir, 'versions'), { recursive: true })
  mkdirSync(join(runDir, 'checks'), { recursive: true })
  if (kind === 'file') copyFileSync(input, join(runDir, 'versions', 'v0.md'))
  const run = {
    schema: 1,
    created_at: now.toISOString(),
    input: { kind, source: kind === 'file' ? resolve(input) : input, name },
    settings: { goal, max_rounds: maxRounds, interactive, auto_path: autoPath, score_only: scoreOnly },
    status: 'active',
    current: null,
    versions: [],
    rounds: [],
    decisions: [],
  }
  writeRun(runDir, run)
  return { runDir, run }
}

// ---------------------------------------------------------------- Paths

const countKind = (path, kind) => path.changes.filter((c) => c.edit === kind).length
const reaches = (path) => path.reaches_target ?? path.reaches_band ?? true

/** Ranks the Paths of one Check, best first. A Path's number is its 1-based place in the API's list. */
function rankPaths(paths, { interactive }) {
  let list = paths.map((path, i) => ({ number: i + 1, path }))
  if (list.some((c) => reaches(c.path))) list = list.filter((c) => reaches(c.path))
  if (!interactive) list = list.filter((c) => countKind(c.path, 'needs_author_input') === 0)
  return list.sort((a, b) => countKind(a.path, 'structural') - countKind(b.path, 'structural') || a.path.changes.length - b.path.changes.length || a.number - b.number)
}

const describe = ({ number, path, conflict }) => ({ path: number, mix: path.mix, reaches_target: reaches(path), moves: path.changes.length, needs_author_input: countKind(path, 'needs_author_input'), ...(conflict ? { conflict } : {}) })

// ---------------------------------------------------------------- rounds

const lastRound = (run) => run.rounds[run.rounds.length - 1]
const versionOf = (run, n) => run.versions.find((v) => v.n === n)
const checkOf = (runDir, n) => JSON.parse(readFileSync(join(runDir, 'checks', `v${n}.json`), 'utf8'))

/** Starts the next Round along Path number `path` of the current version's Check. */
export function startRound(runDir, { path, chosenBy = 'user' }) {
  const run = readRun(runDir)
  if (run.status !== 'active') throw new Error('The run is finished.')
  if (['rewriting', 'checking'].includes(lastRound(run)?.stage)) throw new Error(`Round ${lastRound(run).n} is not finished.`)
  const base = run.current
  if (base == null) throw new Error('Check the original post first.')
  if (!existsSync(join(runDir, 'versions', `v${base}.md`))) throw new Error('The run has no text of the post yet. Save it with the `original` command.')
  const chosen = checkOf(runDir, base).paths?.[path - 1]
  if (!chosen) throw new Error(`Version ${base} has no Path ${path}.`)
  const n = run.rounds.length + 1
  run.rounds.push({ n, base, path_number: path, path: chosen, chosen_by: chosenBy, stage: 'rewriting', author_input: [], fidelity: null })
  writeRun(runDir, run)
  return {
    round: n,
    rewrite_from: join(runDir, 'versions', `v${base}.md`),
    write_to: join(runDir, 'versions', `v${n}.md`),
    moves: chosen.changes.map(({ feature, edit, what_it_measures, from, to, instruction }) => ({ feature, edit, what_it_measures, from, to, instruction })),
    keep: (checkOf(runDir, base).keep ?? []).map(({ what_it_measures, value }) => ({ what_it_measures, value })),
  }
}

/** Records the Fidelity check of the Round being rewritten. */
export function recordFidelity(runDir, { passed, summary = '' }) {
  const run = readRun(runDir)
  const round = lastRound(run)
  if (!round || round.stage !== 'rewriting') throw new Error('No Round is waiting for a meaning check.')
  round.fidelity = { passed, summary }
  if (passed) {
    round.stage = 'checking'
    writeRun(runDir, run)
    return { round: round.n, stage: round.stage }
  }
  round.stage = 'done'
  round.outcome = 'meaning_changed'
  return logDecision(runDir, run, decide(runDir, run, { reverted: true }))
}

// ---------------------------------------------------------------- Checks and decisions

/** The goal the run can aim for: the API plans to 0.3 until it echoes `target_p_ai` (SF-323). */
function effectiveGoal(run, body) {
  return body.target_p_ai == null ? Math.max(run.settings.goal, API_DEFAULT_TARGET) : run.settings.goal
}

const pct = (p) => `${Math.round(p * 100)}%`
const confirmOrRewrite = (run) => (run.settings.interactive && !run.settings.auto_path ? 'confirm_path' : 'rewrite')

/** The ranked Paths of the current version that no Round has tried from it. Paths with a known conflict go last. */
function openCandidates(runDir, run) {
  const tried = new Set(run.rounds.filter((r) => r.base === run.current).map((r) => r.path_number))
  const conflicts = run.conflicts?.[run.current] ?? {}
  const open = rankPaths(checkOf(runDir, run.current).paths ?? [], run.settings).filter((c) => !tried.has(c.number)).map((c) => ({ ...c, conflict: conflicts[c.number] }))
  return [...open.filter((c) => !c.conflict), ...open.filter((c) => c.conflict)]
}

/** The manager rules: what the run does after the current version's Check, or after a revert. */
function decide(runDir, run, { reverted = false } = {}) {
  const body = checkOf(runDir, run.current)
  const goal = effectiveGoal(run, body)
  const now = `P(AI) is ${pct(body.p_ai)}`
  const base = { goal, reverted }
  if (body.p_ai < goal) return { ...base, action: 'stop', reason: 'goal_reached', message: `${now}, under the goal of ${pct(goal)}. The run is done.` }
  if (run.settings.score_only) return { ...base, action: 'stop', reason: 'score_only', message: `${now}. Score only: nothing was rewritten.` }
  const all = openCandidates(runDir, run)
  const candidates = all.filter((c) => !c.conflict)
  const listed = { candidates: all.map(describe), recommended: candidates[0] ? describe(candidates[0]) : null }
  if (run.rounds.length >= run.settings.max_rounds) {
    const reaching = candidates.some((c) => reaches(c.path))
    if (reaching && run.settings.interactive) {
      return { ...base, ...listed, action: 'ask_user', reason: 'max_rounds', message: `${now} after ${run.rounds.length} rounds, the limit. A Path that reaches the goal is still offered.`,
        options: [{ id: 'more', label: `Run one more round along the recommended Path (${listed.recommended.mix})`, recommended: true }, { id: 'stop', label: 'Stop and keep the best version' }] }
    }
    return { ...base, ...listed, action: 'stop', reason: 'max_rounds', message: `${now} after ${run.rounds.length} rounds, the limit. ${reaching ? 'The run cannot ask you for more rounds.' : 'No Path that reaches the goal is left.'}` }
  }
  if (candidates.length === 0) {
    if (!run.settings.interactive) return { ...base, ...listed, action: 'stop', reason: 'no_path_left', message: `${now}, above the goal of ${pct(goal)}, and no Path is left.` }
    return { ...base, ...listed, action: 'ask_user', reason: 'no_path_left', message: `${now}, above the goal of ${pct(goal)}, and the API offers no Path that has not been tried.`,
      options: [{ id: 'stop', label: 'Stop and keep the best version', recommended: true }] }
  }
  const first = candidates[0]
  const why = reaches(first.path) ? 'it reaches the goal' : 'no offered Path reaches the goal; this one comes closest'
  return { ...base, ...listed, action: confirmOrRewrite(run), reason: reverted ? 'reverted' : 'path_left',
    message: `${reverted ? 'The last round was undone. ' : ''}${now}. Next: the Path "${first.path.mix}", because ${why} with the fewest structural Moves.` }
}

/** Writes the best version as <name>.deslopped.md: next to the input file, or in the run folder for a URL. */
function writeOutput(runDir, run) {
  if (!run.current) return null
  const folder = run.input.kind === 'file' ? dirname(run.input.source) : runDir
  const output = join(folder, `${run.input.kind === 'file' ? basename(run.input.source, extname(run.input.source)) : run.input.name}.deslopped.md`)
  if (resolve(output) === resolve(run.input.source)) throw new Error('The output would overwrite the input.')
  copyFileSync(join(runDir, 'versions', `v${run.current}.md`), output)
  return output
}

function finish(runDir, run) {
  run.status = 'done'
  run.output = writeOutput(runDir, run)
}

function logDecision(runDir, run, decision) {
  run.decisions.push({ at_round: run.rounds.length, version: run.current, action: decision.action, reason: decision.reason, message: decision.message })
  run.next = decision
  if (decision.action === 'stop') finish(runDir, run)
  writeRun(runDir, run)
  return { decision, run, report: join(runDir, 'report.html'), output: run.output ?? null }
}

/** Marks Path number `path` of the current version as breaking a known Constraint, then decides again. */
export function markConflict(runDir, { path, reason }) {
  const run = readRun(runDir)
  if (!reason) throw new Error('Give the reason of the conflict.')
  run.conflicts = run.conflicts ?? {}
  run.conflicts[run.current] = { ...run.conflicts[run.current], [path]: reason }
  return logDecision(runDir, run, decide(runDir, run))
}

/** Raises the round limit after the user allows more rounds, then decides again. */
export function extendRounds(runDir, { rounds = 1 } = {}) {
  const run = readRun(runDir)
  run.settings.max_rounds += rounds
  return logDecision(runDir, run, decide(runDir, run))
}

/** Stops the run on the user's word and writes the output. */
export function stopRun(runDir, { reason = 'You stopped the run.' } = {}) {
  const run = readRun(runDir)
  return logDecision(runDir, run, { action: 'stop', reason: 'user_stopped', message: reason })
}

/** Saves the text of the post for a URL run: the post as the skill fetched it. */
export function setOriginal(runDir, { file }) {
  const run = readRun(runDir)
  if (run.rounds.length) throw new Error('The original can change only before round 1.')
  copyFileSync(file, join(runDir, 'versions', 'v0.md'))
  writeRun(runDir, run)
  return { original: join(runDir, 'versions', 'v0.md') }
}

/** Records the Author input for one Move of the Round being rewritten, or that the user skipped it. */
export function recordAuthorInput(runDir, { feature, value = null, source = null, skipped = false }) {
  const run = readRun(runDir)
  const round = lastRound(run)
  if (round?.stage !== 'rewriting') throw new Error('No Round is being rewritten.')
  if (!round.path.changes.some((c) => c.feature === feature && c.edit === 'needs_author_input')) throw new Error(`Round ${round.n} has no author input Move for ${feature}.`)
  if (!skipped && !value) throw new Error('Give the confirmed value, or mark the Move as skipped.')
  round.author_input = [...round.author_input.filter((a) => a.feature !== feature), { feature, value, source, skipped }]
  writeRun(runDir, run)
  return { round: round.n, author_input: round.author_input }
}

/** Records the token use of one phase. */
export function recordTokens(runDir, { phase, tokens, estimated = false }) {
  const run = readRun(runDir)
  if (!Number.isFinite(tokens)) throw new Error('Give the token count as a number.')
  run.tokens = [...(run.tokens ?? []), { phase, tokens, estimated, round: run.rounds.length }]
  writeRun(runDir, run)
  return { tokens: run.tokens.reduce((sum, u) => sum + u.tokens, 0) }
}

/** Shows a banner in the report, for a judgement only the host model can make. */
export function flag(runDir, { notBlogPost = false }) {
  const run = readRun(runDir)
  run.flags = { ...run.flags, not_blog_post: notBlogPost }
  writeRun(runDir, run)
  return { flags: run.flags }
}

/** The run's state and its last decision, for an agent that resumes work in a run folder. */
export function status(runDir) {
  const run = readRun(runDir)
  return { status: run.status, current: run.current, round: lastRound(run) ?? null, decision: run.next ?? null, report: join(runDir, 'report.html'), output: run.output ?? null }
}

// ---------------------------------------------------------------- the API call

/** The version a Check is waiting for: the original, or the Round whose meaning check passed. */
function pendingVersion(run) {
  if (run.status !== 'active') throw new Error('The run is finished.')
  const round = lastRound(run)
  if (run.versions.length === 0) return 0
  if (round?.stage === 'checking') return round.n
  if (round?.stage === 'rewriting') throw new Error(`Record the meaning check of round ${round.n} first.`)
  throw new Error('No version is waiting for a Check.')
}

/** Checks the pending version with the Slop API (SLOP_API_URL, default https://sitefire.ai) and decides the next step. */
export async function check(runDir, { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const run = readRun(runDir)
  const n = pendingVersion(run)
  const text = readText(join(runDir, 'versions', `v${n}.md`))
  const input = text != null ? { text } : { url: run.input.source }
  const base = (env.SLOP_API_URL || 'https://sitefire.ai').replace(/\/+$/, '')
  let response
  try {
    const res = await fetchImpl(`${base}/api/slop/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, target_p_ai: run.settings.goal }),
      signal: AbortSignal.timeout(90_000),
    })
    const raw = await res.text()
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { error: { code: res.ok ? 'internal' : res.status === 404 ? 'not_found' : 'internal', retry_after: null } }
    }
    response = { status: res.ok && !body.error ? 200 : res.status || 500, body, headers: { 'retry-after': res.headers.get('retry-after') } }
  } catch (error) {
    response = { status: 0, body: { error: { code: 'network', retry_after: null, detail: String(error.message ?? error) } } }
  }
  return recordCheck(runDir, response, { now })
}

// The causes of the API's error codes, from docs/slop-api/README.md in sitefire-website.
const ERROR_CAUSES = {
  not_found: 'The API is not available at this address.',
  invalid_json: 'The request body was not a JSON object.',
  invalid_url: 'The URL is not an http or https URL.',
  url_homepage: 'The URL is a homepage, not a post.',
  url_refused: 'The URL is on sitefire.ai or in a private address range.',
  paste_too_long: 'The post has more than 20,000 characters.',
  paste_too_short: 'The post has fewer than 300 words.',
  rate_limited: 'The daily limit of 30 Checks per IP address, or the burst guard, refused the Check.',
  budget_exhausted: 'The daily spend budget of the API is used up.',
  provider_key_missing: 'A provider key is not set on the server.',
  score_quota: 'The AI Gateway of the API has no credits.',
  fetch_blocked: 'The API could not fetch the post from the URL.',
  fetch_not_html: 'The URL does not return an HTML page.',
  fetch_too_large: 'The page at the URL is too large.',
  fetch_short: 'The API got fewer than 300 words from the URL.',
  fetch_failed: 'The site failed to answer.',
  fetch_provider: 'The fetch provider of the API failed.',
  score_rate_limited: 'The scoring model asked the API to wait.',
  score_failed: 'The scoring model failed.',
  timeout: 'The scoring model did not answer in 30 seconds.',
  store_failed: 'The API could not read or write the stored Check.',
  internal: 'The API had a server failure.',
  network: 'The API could not be reached.',
}

// fetch_short is not here: the post is too short to score, whoever fetches it.
const FETCH_LOCALLY = new Set(['fetch_blocked', 'fetch_not_html', 'fetch_too_large', 'fetch_failed', 'fetch_provider'])

function retryText(seconds, now) {
  if (seconds == null) return ''
  const at = new Date(now.getTime() + seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
  return ` Try again in ${seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`} (at ${at} UTC).`
}

function recordError(runDir, run, response, now) {
  const e = response.body?.error ?? { code: 'internal' }
  const retryAfter = e.retry_after ?? (Number(response.headers?.['retry-after']) || null)
  const error = { code: e.code, status: response.status, retry_after: retryAfter, request_id: e.request_id ?? null, at: now.toISOString() }
  if (run.versions.length === 0 && run.input.kind === 'url' && !existsSync(join(runDir, 'versions', 'v0.md')) && FETCH_LOCALLY.has(e.code)) {
    return logDecision(runDir, run, { action: 'fetch_locally', reason: 'api_error', error,
      message: `The API could not fetch the post (${e.code}). Fetch it yourself, save it with the \`original\` command, and check again.` })
  }
  run.error = error
  const cause = ERROR_CAUSES[e.code] ?? 'The API refused the Check.'
  const ref = error.request_id ? ` Request id: ${error.request_id}.` : ''
  const said = e.code === 'network' ? `The Slop API could not be reached (${e.detail ?? 'no answer'}).` : `The Slop API answered ${e.code}: ${cause}`
  return logDecision(runDir, run, { action: 'stop', reason: 'api_error', error,
    message: `${said}${retryText(retryAfter, now)}${ref} The run folder is kept.` })
}

/** Records one Slop API response for the version being checked, then decides the next step. */
export function recordCheck(runDir, response, { now = new Date() } = {}) {
  const run = readRun(runDir)
  const round = lastRound(run)
  const n = pendingVersion(run)
  if (response.status !== 200) return recordError(runDir, run, response, now)
  const body = response.body
  writeFileSync(join(runDir, 'checks', `v${n}.json`), `${JSON.stringify(body, null, 2)}\n`)
  run.versions.push({ n, p_ai: body.p_ai, band: body.band, margin: body.margin ?? null, target_p_ai: body.target_p_ai ?? null, word_count: body.word_count, truncated: body.truncated, warnings: body.warnings ?? [], bundle_version: body.bundle_version })
  let reverted = false
  if (round && n === round.n) {
    reverted = body.p_ai > versionOf(run, round.base).p_ai
    round.stage = 'done'
    round.outcome = reverted ? 'reverted' : 'kept'
    if (!reverted) run.current = n
  } else {
    run.current = n
  }
  return logDecision(runDir, run, decide(runDir, run, { reverted }))
}

// ---------------------------------------------------------------- the report (layout W of the prototype)

const BAND_NAME = { human_shaped: 'Human-shaped', borderline: 'Borderline', ai_shaped: 'AI-shaped' }
const KIND_NAME = { local: 'local', structural: 'structural', needs_author_input: 'author input' }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)

function titleOf(runDir, run) {
  const text = readText(join(runDir, 'versions', 'v0.md'))
  const line = text?.split('\n').map((l) => l.trim()).find(Boolean)
  return line ? line.replace(/^#+\s*/, '').slice(0, 140) : run.input.name
}

function chip(band, id) {
  return `<span class="chip band-${esc(band)}"${id ? ` id="${id}"` : ''}><span class="sw"></span>${esc(BAND_NAME[band] ?? band)}</span>`
}

function lineChart({ id, label, points, rounds, y, ticks, zones = '', goal = null, fmt }) {
  const W = 640, H = 230, L = 48, R = 18, T = 14, B = 30
  const xs = (n) => L + (n / Math.max(rounds, 1)) * (W - L - R)
  const ys = (v) => T + (1 - (v - y[0]) / (y[1] - y[0])) * (H - T - B)
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`
  s += zones ? zones(L, W - R, ys) : ''
  for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${ys(t)}" y2="${ys(t)}"/><text x="${L - 8}" y="${ys(t) + 4}" text-anchor="end">${fmt(t)}</text>`
  if (goal != null) s += `<line class="goal" x1="${L}" x2="${W - R}" y1="${ys(goal)}" y2="${ys(goal)}"/><text class="zl goal-t" x="${L + 6}" y="${ys(goal) - 5}">GOAL UNDER ${pct(goal)}</text>`
  const measured = new Set(points.map((p) => p.n))
  for (let n = 0; n <= rounds; n++) {
    if (!measured.has(n)) s += `<line class="slot" x1="${xs(n)}" x2="${xs(n)}" y1="${ys(y[1])}" y2="${ys(y[0])}"/>`
    s += `<text x="${xs(n)}" y="${H - 8}" text-anchor="middle">${n === 0 ? 'start' : `R${n}`}</text>`
  }
  const kept = points.filter((p) => !p.reverted)
  s += `<polyline class="line" points="${kept.map((p) => `${xs(p.n)},${ys(p.v)}`).join(' ')}"/>`
  for (const p of points) {
    s += `<g class="hit" data-round="${p.n}"><circle class="pt ${p.reverted ? 'reverted' : esc(p.band)}" cx="${xs(p.n)}" cy="${ys(p.v)}" r="6"><title>${p.n === 0 ? 'Original' : `Round ${p.n}`}${p.reverted ? ' (undone)' : ''}: ${fmt(p.v)}</title></circle>`
    s += `<text class="val" x="${xs(p.n) + (p.n === rounds ? -10 : 10)}" y="${ys(p.v) - 9}" text-anchor="${p.n === rounds ? 'end' : 'start'}">${fmt(p.v)}</text></g>`
  }
  return `<section class="card fig"><p class="eyebrow">${esc(label)}</p><div class="chart" id="${id}">${s}</svg></div></section>`
}

function pChart(run, goal, rounds) {
  const reverted = new Set(run.rounds.filter((r) => r.outcome === 'reverted').map((r) => r.n))
  const points = run.versions.map((v) => ({ n: v.n, v: v.p_ai, band: v.band, reverted: reverted.has(v.n) }))
  const zones = (x1, x2, ys) => `<rect class="zone-a" x="${x1}" y="${ys(1)}" width="${x2 - x1}" height="${ys(0.7) - ys(1)}"/><rect class="zone-h" x="${x1}" y="${ys(0.3)}" width="${x2 - x1}" height="${ys(0) - ys(0.3)}"/>` +
    `<text class="zl" x="${x2 - 6}" y="${ys(1) + 14}" text-anchor="end">AI-SHAPED</text><text class="zl" x="${x2 - 6}" y="${ys(0) - 7}" text-anchor="end">HUMAN-SHAPED</text>`
  return lineChart({ id: 'p-chart', label: 'P(AI) by round', points, rounds, y: [0, 1], ticks: [0, 0.3, 0.7, 1], zones, goal, fmt: pct })
}

function marginChart(run, rounds) {
  const reverted = new Set(run.rounds.filter((r) => r.outcome === 'reverted').map((r) => r.n))
  const points = run.versions.filter((v) => typeof v.margin === 'number').map((v) => ({ n: v.n, v: v.margin, band: v.band, reverted: reverted.has(v.n) }))
  if (points.length === 0) return ''
  const lo = Math.min(0, ...points.map((p) => p.v)), hi = Math.max(0, ...points.map((p) => p.v))
  const pad = Math.max(1, (hi - lo) * 0.12)
  const fig = lineChart({ id: 'margin-chart', label: 'Margin by round', points, rounds, y: [lo - pad, hi + pad], ticks: [0], fmt: (v) => v.toFixed(1) })
  return fig.replace('</section>', '<p class="muted small">The detector’s score before calibration. Lower is more human. It moves while P(AI) still reads 100%.</p></section>')
}

function moveItem(change, input) {
  const author = input ? `<div class="muted small">${input.skipped ? 'Author input skipped: this Move was dropped.' : `Author input: ${esc(input.value)}${input.source ? ` (from ${esc(input.source)})` : ''}`}</div>` : ''
  return `<li class="move${input?.skipped ? ' dropped' : ''}"><span class="kind ${esc(change.edit)}">${esc(KIND_NAME[change.edit] ?? change.edit)}</span>
    <div class="what"><b>${esc(change.what_it_measures)}</b> <span class="fromto">· ${esc(change.from)} → ${esc(change.to)}</span></div>
    <div class="instr">${esc(change.instruction)}${author}</div></li>`
}

function offeredPaths(runDir, run, next) {
  const check = checkOf(runDir, run.current)
  const conflicts = run.conflicts?.[run.current] ?? {}
  return next.candidates.map((c) => {
    const path = check.paths[c.path - 1]
    const rec = next.recommended?.path === c.path
    const conflict = conflicts[c.path]
    return `<article class="offer${rec ? ' rec' : ''}"><div class="round-head"><h3>Path ${c.path} <span class="muted thin">· ${esc(path.mix)}</span></h3>
      ${rec ? '<span class="chip"><span class="sw ink"></span>Recommended</span>' : ''}</div>
      ${reaches(path) ? '' : '<p class="small muted">Does not reach the goal on its own.</p>'}
      ${conflict ? `<p class="conflict">Conflicts with a known constraint: ${esc(conflict)}</p>` : ''}
      <ol class="moves">${path.changes.map((ch) => moveItem(ch)).join('')}</ol></article>`
  }).join('')
}

function roundItem(run, round) {
  const after = versionOf(run, round.n)
  const before = versionOf(run, round.base)
  const inputs = new Map(round.author_input.map((a) => [a.feature, a]))
  const stage = { rewriting: 'Rewriting', checking: 'Checking' }[round.stage]
  const node = stage ? 'pending pulse' : round.outcome === 'kept' ? esc(after.band) : 'undone'
  const right = stage ? `<span class="chip pulse">${stage}…</span>` : after ? `<span class="tl-p num">${pct(after.p_ai)}</span>` : '<span class="chip">Undone</span>'
  const outcome = {
    kept: after && `${pct(before.p_ai)} → ${pct(after.p_ai)}`,
    reverted: after && `${pct(before.p_ai)} → ${pct(after.p_ai)} · P(AI) went up, so this round was undone`,
    meaning_changed: 'The meaning check failed, so this round was undone',
  }[round.outcome]
  const fidelity = round.fidelity ? `<p class="muted small">Meaning check: ${round.fidelity.passed ? 'passed' : 'failed'}${round.fidelity.summary ? ` · ${esc(round.fidelity.summary)}` : ''}</p>` : ''
  return `<li class="tl-item" data-round="${round.n}"><div class="tl-rail"><span class="tl-node ${node}">${round.n}</span></div>
    <div class="tl-card"><div class="round-head"><h3>Round ${round.n} <span class="muted thin">· Path ${round.path_number} · ${esc(round.path.mix)}</span></h3>${right}</div>
    <p class="delta muted">${outcome ? `${outcome} · ` : ''}${round.chosen_by === 'auto' ? 'Path chosen by the skill' : 'Path confirmed by you'}</p>
    <ol class="moves">${round.path.changes.map((ch) => moveItem(ch, inputs.get(ch.feature))).join('')}</ol>${fidelity}</div></li>`
}

function timeline(runDir, run) {
  const items = []
  const v0 = versionOf(run, 0)
  items.push(`<li class="tl-item" data-round="0"><div class="tl-rail"><span class="tl-node ${v0 ? esc(v0.band) : 'pending'}">0</span></div>
    <div class="tl-card"><div class="round-head"><h3>Original post</h3>${v0 ? `<span class="tl-p num">${pct(v0.p_ai)}</span>` : '<span class="chip pulse">Checking…</span>'}</div>${v0 ? chip(v0.band) : ''}</div></li>`)
  for (const round of run.rounds) items.push(roundItem(run, round))
  const next = run.next
  const choosing = run.status === 'active' && next && ['confirm_path', 'ask_user', 'rewrite'].includes(next.action) && next.candidates?.length && lastRound(run)?.stage !== 'rewriting' && lastRound(run)?.stage !== 'checking'
  if (choosing) {
    const n = run.rounds.length + 1
    items.push(`<li class="tl-item"><div class="tl-rail"><span class="tl-node pending">${n}</span></div>
      <div class="tl-card"><h3>Paths for round ${n}</h3>${offeredPaths(runDir, run, next)}</div></li>`)
  }
  if (run.status === 'active') {
    for (let n = run.rounds.length + (choosing ? 2 : 1); n <= run.settings.max_rounds; n++) {
      items.push(`<li class="tl-item future"><div class="tl-rail"><span class="tl-node pending faint">${n}</span></div>
        <div class="tl-card empty"><p class="muted small">Round ${n}: only if the goal is not reached and a good Path is left</p></div></li>`)
    }
  }
  return `<section class="stack"><p class="eyebrow">What each round did</p><ol class="tl" id="timeline">${items.join('')}</ol></section>`
}

function banners(run) {
  const list = []
  if (run.flags?.not_blog_post) list.push('This text does not look like a blog post. The detector learned on blog posts only, so read the result with care.')
  const seen = new Set()
  for (const v of run.versions) {
    for (const w of v.warnings ?? []) if (!seen.has(w.code)) { seen.add(w.code); list.push(w.message) }
    if (v.truncated && !seen.has('truncated')) { seen.add('truncated'); list.push('The post is long: the API scored only its first 2,600 words. The rest of the post was not measured.') }
  }
  if (run.error) list.push(`The run stopped on an API error: ${run.next?.message ?? run.error.code}`)
  return list.length ? `<section class="banners" id="banners">${list.map((t) => `<p class="banner">${esc(t)}</p>`).join('')}</section>` : ''
}

function statusLine(run, goal) {
  const next = run.next
  const round = lastRound(run)
  if (run.status === 'done') return next?.reason === 'goal_reached' ? `Done · the goal of under ${pct(goal)} is reached` : `Stopped · ${next?.message ?? ''}`
  if (!run.versions.length) return 'Checking the original post'
  if (round?.stage === 'rewriting') return `Round ${round.n} of ${run.settings.max_rounds} · rewriting along Path ${round.path_number}`
  if (round?.stage === 'checking') return `Round ${round.n} of ${run.settings.max_rounds} · checking the rewrite`
  if (next?.action === 'confirm_path') return `Goal: P(AI) under ${pct(goal)} · waiting for you to confirm a Path`
  if (next?.action === 'ask_user') return 'Waiting for your answer'
  return `Goal: P(AI) under ${pct(goal)}`
}

function keepList(runDir, run) {
  if (run.current == null) return ''
  const keep = checkOf(runDir, run.current).keep ?? []
  if (!keep.length) return ''
  return `<section class="card stack"><p class="eyebrow">Kept on purpose</p><ul class="keep">${keep.map((k) => `<li><span><b>${esc(k.what_it_measures)}</b> · ${esc(k.value)}</span></li>`).join('')}</ul></section>`
}

function tokenLine(run) {
  const uses = run.tokens ?? []
  if (!uses.length) return ''
  const total = uses.reduce((sum, u) => sum + u.tokens, 0)
  const byPhase = {}
  for (const u of uses) byPhase[u.phase] = (byPhase[u.phase] ?? 0) + u.tokens
  const estimated = uses.some((u) => u.estimated) ? ' (estimated)' : ''
  return `<p class="muted small" id="tokens">Token use${estimated}: ${total.toLocaleString('en')} · ${Object.entries(byPhase).map(([k, v]) => `${esc(k)} ${v.toLocaleString('en')}`).join(' · ')}</p>`
}

/** Renders the self-contained report page from the run log. */
export function renderReport(runDir, run) {
  const latest = run.current == null ? null : versionOf(run, run.current)
  const goal = latest ? effectiveGoal(run, checkOf(runDir, run.current)) : run.settings.goal
  const rounds = Math.max(run.settings.max_rounds, run.rounds.length)
  const words = versionOf(run, 0)?.word_count
  const source = run.input.kind === 'url' ? run.input.source : basename(run.input.source)
  const readout = latest
    ? `<div class="readout"><span class="lbl">P(AI) now</span><span class="big num" id="p-now">${pct(latest.p_ai)}</span>${chip(latest.band, 'band-now')}</div>
       <p class="muted small">Measured by the Slop API ${latest.n === 0 ? 'on the original post' : `after round ${latest.n}`}</p>`
    : '<div class="readout"><span class="lbl">P(AI) now</span><span class="big num" id="p-now">…</span></div>'
  const live = run.status === 'active' ? `<script>if (location.protocol === 'file:') setTimeout(() => location.reload(), 5000)</script>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deslop Run Report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>${CSS}</style></head>
<body><div class="wrap">
<section class="card top"><div class="stack tight">
  <p class="eyebrow">Deslop run${words ? ` · ${words.toLocaleString('en')} words` : ''} · up to ${run.settings.max_rounds} rounds</p>
  <h1>${esc(titleOf(runDir, run))}</h1><p class="muted small">${esc(source)}</p>
  <p id="status">${esc(statusLine(run, goal))}</p></div>
  <div class="stack tight">${readout}</div></section>
${banners(run)}
${run.next?.message ? `<p class="manager" id="manager">${esc(run.next.message)}</p>` : ''}
${pChart(run, goal, rounds)}
${marginChart(run, rounds)}
${timeline(runDir, run)}
${keepList(runDir, run)}
<footer class="stack tight">${tokenLine(run)}<p class="muted small">This skill is an experiment: a post the detector calls human may not read as less AI to people. Every version is kept in the run folder${latest?.bundle_version ? ` · bundle ${esc(latest.bundle_version)}` : ''}.</p></footer>
</div>
<script>document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-round]'); const n = el ? el.dataset.round : null; document.querySelectorAll('[data-round]').forEach((x) => x.classList.toggle('hi', n != null && x.dataset.round === n)) })</script>
${live}</body></html>
`
}

const CSS = `
:root { --bg: #f4f3f1; --surface: #ffffff; --plate: #fbfaf9; --ink: #171717; --ink-2: #4f4d4a; --muted: #76736f; --line: rgba(23,23,23,.09); --line-strong: rgba(23,23,23,.18);
  --human: #e8532b; --human-soft: rgba(251,95,53,.11); --ai: #5d6e93; --ai-soft: rgba(103,120,155,.12); --mid: #8d8a85; --ring: rgba(23,23,23,.35);
  --font-body: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #121211; --surface: #1b1b1a; --plate: #171716; --ink: #f1f0ee; --ink-2: #c4c1bc; --muted: #94918c;
  --line: rgba(241,240,238,.10); --line-strong: rgba(241,240,238,.22); --human: #ff7a55; --human-soft: rgba(255,122,85,.14); --ai: #93a3c8; --ai-soft: rgba(147,163,200,.14); --mid: #a3a09a; --ring: rgba(241,240,238,.45); color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #121211; --surface: #1b1b1a; --plate: #171716; --ink: #f1f0ee; --ink-2: #c4c1bc; --muted: #94918c;
  --line: rgba(241,240,238,.10); --line-strong: rgba(241,240,238,.22); --human: #ff7a55; --human-soft: rgba(255,122,85,.14); --ai: #93a3c8; --ai-soft: rgba(147,163,200,.14); --mid: #a3a09a; --ring: rgba(241,240,238,.45); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.5; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 64px; display: grid; gap: 16px; }
h1, h2, h3 { margin: 0; font-weight: 600; text-wrap: balance; } h1 { font-size: 22px; line-height: 1.25; } h3 { font-size: 15px; } p { margin: 0; }
.eyebrow { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.card { background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--line); padding: 18px; min-width: 0; }
.stack { display: grid; gap: 12px; min-width: 0; } .stack.tight { gap: 6px; }
.top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px 24px; align-items: end; }
.fig { display: grid; gap: 12px; }
.num { font-variant-numeric: tabular-nums; } .muted { color: var(--muted); } .small { font-size: 13px; } .thin { font-weight: 400; }
.chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 9px; font-size: 12px; line-height: 1.3; white-space: nowrap; box-shadow: 0 0 0 1px var(--line); color: var(--ink-2); background: var(--surface); width: fit-content; }
.chip .sw { width: 7px; height: 7px; border-radius: 50%; } .sw.ink { background: var(--ink); }
.band-human_shaped .sw { background: var(--human); } .band-borderline .sw { background: var(--mid); } .band-ai_shaped .sw { background: var(--ai); }
.kind { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; border-radius: 5px; padding: 2px 6px; box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--ink-2); white-space: nowrap; }
.kind.needs_author_input { box-shadow: inset 0 0 0 1px var(--human); color: var(--human); }
.pulse { animation: pulse 1.6s ease-in-out infinite; } @keyframes pulse { 50% { opacity: .35; } } @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.readout { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.readout .big { font-size: 44px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
.readout .lbl { font-family: var(--font-mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.banners { display: grid; gap: 8px; } .banner { border-left: 3px solid var(--human); background: var(--human-soft); border-radius: 6px; padding: 8px 12px; font-size: 14px; }
.manager { border-left: 3px solid var(--ink); padding: 2px 0 2px 12px; font-size: 14px; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart text { fill: var(--muted); font-family: var(--font-mono); font-size: 11px; }
.chart .zone-h { fill: var(--human-soft); } .chart .zone-a { fill: var(--ai-soft); }
.chart .grid { stroke: var(--line-strong); stroke-dasharray: 3 4; } .chart .slot { stroke: var(--line-strong); stroke-dasharray: 2 4; }
.chart .line { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; }
.chart .pt { stroke: var(--surface); stroke-width: 2.5; fill: var(--ink); } .chart .pt.human_shaped { fill: var(--human); } .chart .pt.borderline { fill: var(--mid); } .chart .pt.ai_shaped { fill: var(--ai); }
.chart .pt.reverted { fill: var(--surface); stroke: var(--muted); stroke-dasharray: 2 2; }
.chart .hit.hi .pt { stroke: var(--ink); } .chart .val { fill: var(--ink); font-size: 12px; font-weight: 500; }
.chart .zl { font-size: 10px; letter-spacing: .05em; } .chart .goal { stroke: var(--human); stroke-width: 1.5; stroke-dasharray: 6 4; } .chart .goal-t { fill: var(--human); }
.round-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.moves { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.move { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: start; } .move.dropped { opacity: .55; }
.move .kind { grid-row: span 2; margin-top: 2px; } .move .what { color: var(--ink-2); font-size: 13.5px; min-width: 0; } .move .what b { color: var(--ink); font-weight: 500; }
.move .instr { font-size: 14px; min-width: 0; } .fromto { color: var(--muted); font-size: 13px; }
.delta { font-family: var(--font-mono); font-size: 13px; }
.offer { display: grid; gap: 10px; border-radius: 10px; box-shadow: 0 0 0 1px var(--line); padding: 14px 16px; } .offer.rec { box-shadow: 0 0 0 1.5px var(--ink); }
.conflict { font-size: 13px; color: var(--human); }
.keep { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; } .keep li { display: flex; gap: 8px; font-size: 13.5px; color: var(--ink-2); }
.keep li::before { content: "✓"; color: var(--muted); } .keep b { font-weight: 500; color: var(--ink); }
.tl { list-style: none; margin: 0; padding: 0; display: grid; }
.tl-item { display: grid; grid-template-columns: 40px minmax(0, 1fr); }
.tl-rail { position: relative; display: flex; justify-content: center; }
.tl-rail::before { content: ""; position: absolute; top: 0; bottom: 0; width: 2px; background: var(--line-strong); }
.tl-item:first-child .tl-rail::before { top: 18px; } .tl-item:last-child .tl-rail::before { bottom: calc(100% - 18px); }
.tl-node { position: relative; margin-top: 8px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--bg); background: var(--ink); color: var(--surface); font: 600 11px/18px var(--font-mono); text-align: center; }
.tl-node.human_shaped { background: var(--human); } .tl-node.ai_shaped { background: var(--ai); } .tl-node.borderline { background: var(--mid); }
.tl-node.pending, .tl-node.undone { background: var(--surface); color: var(--ink); border: 2px dashed var(--ink); } .tl-node.faint { opacity: .5; }
.tl-card { margin: 0 0 14px; border-radius: 10px; padding: 12px 14px; background: var(--surface); box-shadow: 0 0 0 1px var(--line); display: grid; gap: 10px; min-width: 0; }
.tl-card.empty { background: transparent; } .tl-item.hi .tl-card { background: color-mix(in oklab, var(--ink) 5%, var(--surface)); }
.tl-p { font-size: 26px; font-weight: 600; letter-spacing: -.01em; }
@media (max-width: 760px) { .top { grid-template-columns: minmax(0, 1fr); } .readout .big { font-size: 38px; } }
`

// ---------------------------------------------------------------- command line

const HELP = `Usage: node deslop.mjs <command> [run-folder] [options]. Every command prints JSON.

  init <file-or-url> [--goal 0.2] [--max-rounds 3] [--non-interactive] [--auto-path] [--score-only] [--runs-dir deslop-runs]
  check <run>                                   Check the pending version with the Slop API, then decide.
  original <run> --file <path>                  Save the post text of a URL run (before round 1).
  conflict <run> --path <n> --reason <text>     Mark a Path as breaking a known Constraint, then decide again.
  start-round <run> --path <n> [--auto]         Start the next Round along Path n.
  author-input <run> --feature <id> (--value <text> --source <site|tool|writer> | --skip)
  fidelity <run> (--pass | --fail) [--summary <text>]
  tokens <run> --phase <name> --count <n> [--estimated]
  flag <run> --not-blog-post                    Show the not-a-blog-post banner.
  extend <run> [--rounds 1]                     Allow more rounds, then decide again.
  stop <run> [--reason <text>]                  Stop the run and write the output.
  status <run>                                  Print the state and the last decision.
  render <run>                                  Render report.html again.

SLOP_API_URL sets the API base URL (default https://sitefire.ai).`

function parseArgs(argv) {
  const [command, ...rest] = argv
  const positional = []
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) options[key] = true
    else { options[key] = value; i++ }
  }
  return { command, positional, options }
}

const number = (v, name) => {
  const n = Number(v)
  if (v === undefined || v === true || !Number.isFinite(n)) throw new Error(`--${name} needs a number.`)
  return n
}

async function main(argv) {
  const { command, positional: [target], options: o } = parseArgs(argv)
  const need = () => { if (!target) throw new Error(`${command} needs a run folder.`); return target }
  switch (command) {
    case 'init': {
      if (!target) throw new Error('init needs a file or a URL.')
      const goal = o.goal === undefined ? DEFAULT_GOAL : number(o.goal, 'goal')
      if (goal <= 0 || goal >= 1) throw new Error('--goal must be between 0 and 1.')
      const { runDir, run } = init({ input: target, goal, maxRounds: o['max-rounds'] === undefined ? DEFAULT_MAX_ROUNDS : number(o['max-rounds'], 'max-rounds'),
        interactive: !o['non-interactive'], autoPath: Boolean(o['auto-path']), scoreOnly: Boolean(o['score-only']), runsDir: o['runs-dir'] ?? 'deslop-runs' })
      return { run: runDir, report: join(runDir, 'report.html'), settings: run.settings, original: run.input.kind === 'file' ? join(runDir, 'versions', 'v0.md') : null }
    }
    case 'check': return compact(await check(need()))
    case 'original': return setOriginal(need(), { file: o.file })
    case 'conflict': return compact(markConflict(need(), { path: number(o.path, 'path'), reason: o.reason }))
    case 'start-round': return startRound(need(), { path: number(o.path, 'path'), chosenBy: o.auto ? 'auto' : 'user' })
    case 'author-input': return recordAuthorInput(need(), { feature: o.feature, value: o.value === true ? null : o.value, source: o.source, skipped: Boolean(o.skip) })
    case 'fidelity': {
      if (Boolean(o.pass) === Boolean(o.fail)) throw new Error('Give --pass or --fail.')
      const result = recordFidelity(need(), { passed: Boolean(o.pass), summary: o.summary === true ? '' : o.summary })
      return result.decision ? compact(result) : result
    }
    case 'tokens': return recordTokens(need(), { phase: o.phase, tokens: number(o.count, 'count'), estimated: Boolean(o.estimated) })
    case 'flag': return flag(need(), { notBlogPost: Boolean(o['not-blog-post']) })
    case 'extend': return compact(extendRounds(need(), { rounds: o.rounds === undefined ? 1 : number(o.rounds, 'rounds') }))
    case 'stop': return compact(stopRun(need(), { reason: o.reason === true ? undefined : o.reason }))
    case 'status': return status(need())
    case 'render': {
      const run = readRun(need())
      writeRun(target, run)
      return { report: join(target, 'report.html') }
    }
    default: return { help: HELP }
  }
}

/** The command-line view of a decision: what the agent needs, without the whole run log. */
const compact = ({ decision, report, output }) => ({ decision, report, output })

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then(
    (result) => console.log(result.help ?? JSON.stringify(result, null, 2)),
    (error) => { console.log(JSON.stringify({ error: error.message }, null, 2)); process.exitCode = 1 },
  )
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { check, dropTitleLine, extendRounds, init, markConflict, markdownToText, postWords, recordCheck, recordFidelity, setOriginal, startRound } from '../skills/deslop-structure/scripts/deslop.mjs'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const golden = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
const ok = (body) => ({ status: 200, body })

const POST = '# How to make asynchronous communication work\n\nSome text.\n'

function newRun(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  const file = join(dir, 'post.md')
  writeFileSync(file, POST)
  return init({ input: file, runsDir: join(dir, 'runs'), ...options })
}

const runLog = (runDir) => JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))

test('an ai_shaped post in interactive mode gets the cheapest reaching Path and a confirmation question', () => {
  const { runDir } = newRun()
  const { decision } = recordCheck(runDir, ok(golden('ai_shaped')))
  assert.equal(decision.action, 'confirm_path')
  assert.equal(decision.recommended.mix, '3 local')
  assert.equal(runLog(runDir).versions[0].p_ai, golden('ai_shaped').p_ai)
})

test('non-interactive mode drops the Paths that need author input', () => {
  const { runDir } = newRun({ interactive: false })
  const { decision } = recordCheck(runDir, ok(golden('ai_shaped')))
  assert.deepEqual(decision.candidates.map((c) => c.mix), ['3 local'])
})

test('auto path rewrites along the recommended Path without a confirmation question', () => {
  const { runDir } = newRun({ autoPath: true })
  const { decision } = recordCheck(runDir, ok(golden('ai_shaped')))
  assert.equal(decision.action, 'rewrite')
  assert.equal(decision.recommended.mix, '3 local')
})

/** A Check in the SF-323 shape: the score at the top level, the rewrite guidance in `feedback`, `reaches_target` on each Path. */
function sf323(flat, { margin, target = 0.2 } = {}) {
  const { paths, keep, text, ...top } = flat
  const toTarget = paths.map(({ reaches_band, ...path }) => ({ ...path, reaches_target: reaches_band ?? true }))
  return { ...top, margin: margin ?? top.margin, feedback: { target_p_ai: target, paths: toTarget, keep, text } }
}

/** The SF-323 Check of a rewrite: P(AI) 0.24 with one Path left, unless the overrides say otherwise. */
function afterRound(overrides) {
  const body = golden('ai_shaped')
  return sf323({ ...body, margin: 1.6, p_ai: 0.24, band: 'human_shaped', paths: body.paths.slice(0, 1), ...overrides })
}

/** Runs round 1 along the recommended Path and records the given Check of the rewrite. */
function roundOne(runDir, body) {
  const first = recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  const { write_to } = startRound(runDir, { path: first.decision.recommended.path })
  writeFileSync(write_to, 'The rewrite.\n')
  recordFidelity(runDir, { passed: true, summary: '9 of 9 claims kept' })
  return recordCheck(runDir, ok(body))
}

test('P(AI) 0.24 with goal 0.2 and a Path left: the run continues', () => {
  const { runDir } = newRun()
  const { decision } = roundOne(runDir, afterRound())
  assert.equal(decision.action, 'confirm_path')
  assert.equal(decision.recommended.mix, '3 local')
})

test('P(AI) 0.24 and no Path left: the user is asked whether to stop', () => {
  const { runDir } = newRun()
  const { decision } = roundOne(runDir, afterRound({ paths: [] }))
  assert.equal(decision.action, 'ask_user')
  assert.equal(decision.reason, 'no_path_left')
})

test('P(AI) below the goal: the run stops', () => {
  const { runDir } = newRun()
  const { decision } = roundOne(runDir, afterRound({ p_ai: 0.125, paths: [] }))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'goal_reached')
})

test('P(AI) went up: the round is reverted and the next candidate Path of the better version is recommended', () => {
  const { runDir } = newRun()
  const { decision, run } = roundOne(runDir, sf323({ ...golden('ai_shaped'), p_ai: 0.99999999 }, { margin: 13.1 }))
  assert.equal(decision.action, 'confirm_path')
  assert.equal(decision.reverted, true)
  assert.equal(decision.recommended.mix, '2 local + 1 author input')
  assert.equal(run.current, 0)
  assert.equal(run.rounds[0].outcome, 'reverted')
})

/** Runs `rounds` rounds, with a max of `rounds`; the last Check gets the `last` overrides. */
function runRounds(rounds, last) {
  const { runDir } = newRun({ maxRounds: rounds })
  let result = recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  for (let n = 1; n <= rounds; n++) {
    const { write_to } = startRound(runDir, { path: result.decision.recommended.path })
    writeFileSync(write_to, `Rewrite ${n}.\n`)
    recordFidelity(runDir, { passed: true })
    result = recordCheck(runDir, ok(afterRound({ p_ai: 0.5 - n * 0.1, band: 'borderline', ...(n === rounds ? last : {}) })))
  }
  return { runDir, ...result }
}

test('max rounds reached with a Path left: the user is asked', () => {
  const { decision } = runRounds(2)
  assert.equal(decision.action, 'ask_user')
  assert.equal(decision.reason, 'max_rounds')
})

test('max rounds reached without a Path left: the run stops', () => {
  const { decision } = runRounds(2, { paths: [] })
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'max_rounds')
})

/** An error response in the Checker's envelope, as the Slop API sends it. */
function failure(status, code, retryAfter = null) {
  return { status, body: { error: { code, stage: 'admission', request_id: 'req-1', retryable: retryAfter != null, retry_after: retryAfter, copy_key: `marketing.slopChecker.errors.${code}` } } }
}

for (const [status, code, retryAfter] of [[429, 'rate_limited', 3600], [503, 'budget_exhausted', 7200], [422, 'fetch_short', null], [422, 'post_too_long', null]]) {
  test(`${code}: the run stops with the API's message and retry_after, and keeps its folder`, () => {
    const { runDir } = newRun()
    const { decision } = recordCheck(runDir, failure(status, code, retryAfter))
    assert.equal(decision.action, 'stop')
    assert.equal(decision.reason, 'api_error')
    assert.equal(decision.error.code, code)
    assert.equal(decision.error.retry_after, retryAfter)
    assert.match(decision.message, new RegExp(code))
    const run = runLog(runDir)
    assert.equal(run.status, 'done')
    assert.equal(run.error.code, code)
  })
}

test('a URL the API cannot fetch: the skill fetches the post itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  const { runDir } = init({ input: 'https://example.com/blog/async', runsDir: dir })
  const { decision } = recordCheck(runDir, failure(422, 'fetch_blocked'))
  assert.equal(decision.action, 'fetch_locally')
  assert.equal(runLog(runDir).status, 'active')
})

// ---------------------------------------------------------------- the report

const report = (runDir) => readFileSync(join(runDir, 'report.html'), 'utf8')

/** The visible text of the element with this id, tags stripped. */
function textOf(html, id) {
  const open = html.match(new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>`))
  if (!open) return null
  const tag = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'g')
  tag.lastIndex = open.index + open[0].length
  let depth = 1
  let m
  while (depth > 0 && (m = tag.exec(html))) depth += m[1] ? -1 : 1
  return html.slice(open.index + open[0].length, m.index).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const timelineRounds = (html) => new Set([...html.matchAll(/class="tl-item[^"]*" data-round="([1-9]\d*)"/g)].map((m) => m[1])).size

test('report, start state: the original P(AI), its Band, the offered Paths and no measured rounds', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(golden('ai_shaped')))
  const html = report(runDir)
  assert.equal(textOf(html, 'p-now'), '100%')
  assert.equal(textOf(html, 'band-now'), 'AI-shaped')
  assert.equal(timelineRounds(html), 0)
  assert.match(textOf(html, 'timeline'), /Recommended/)
})

test('report: the goal line falls back to the API target of 30% while the API does not echo a target', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(golden('ai_shaped')))
  assert.match(textOf(report(runDir), 'p-chart'), /GOAL UNDER 30%/)
})

test('report: the goal line shows the run goal once the API echoes the target', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  assert.match(textOf(report(runDir), 'p-chart'), /GOAL UNDER 20%/)
})

test('report: no margin chart, even when the API sends the margin', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  const html = report(runDir)
  assert.equal(textOf(html, 'margin-chart'), null)
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ''), /[Mm]argin/)
})

test('report, running state: the measured round and the round being rewritten', () => {
  const { runDir } = newRun()
  roundOne(runDir, afterRound({ p_ai: 0.36, band: 'borderline' }))
  startRound(runDir, { path: 1 })
  const html = report(runDir)
  assert.equal(textOf(html, 'p-now'), '36%')
  assert.equal(textOf(html, 'band-now'), 'Borderline')
  assert.equal(timelineRounds(html), 2)
})

test('report, done state: every round and the final P(AI)', () => {
  const { runDir } = newRun()
  roundOne(runDir, afterRound({ p_ai: 0.125, margin: 0.8, paths: [] }))
  const html = report(runDir)
  assert.equal(textOf(html, 'p-now'), '13%')
  assert.equal(textOf(html, 'band-now'), 'Human-shaped')
  assert.equal(timelineRounds(html), 1)
  assert.match(textOf(html, 'status'), /goal/i)
})

test('report: a banner when the post is not in English', () => {
  const { runDir } = newRun()
  const warning = { code: 'not_english', message: 'The study measured English posts. Scores on other languages are indicative.' }
  recordCheck(runDir, ok({ ...golden('ai_shaped'), language: 'other', warnings: [warning] }))
  assert.match(textOf(report(runDir), 'banners'), /Scores on other languages are indicative/)
})

test('report: the run log records no truncated field, and the report shows no 2,600-word banner', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok({ ...golden('ai_shaped'), truncated: true, word_count: 3400 }))
  assert.equal('truncated' in runLog(runDir).versions[0], false)
  assert.doesNotMatch(report(runDir), /2,600 words/)
})

test('post_too_long: the stop message says the limit in words', () => {
  const { runDir } = newRun()
  const { decision } = recordCheck(runDir, failure(422, 'post_too_long'))
  assert.match(decision.message, /post_too_long: The post has more than 10,000 words/)
})

// ---------------------------------------------------------------- outputs, constraints and the API call

test('a finished run writes <name>.deslopped.md next to the input and leaves the input as it is', () => {
  const { runDir, run } = newRun()
  roundOne(runDir, afterRound({ p_ai: 0.125, paths: [] }))
  const folder = dirname(run.input.source)
  assert.equal(readFileSync(join(folder, 'post.md'), 'utf8'), POST)
  assert.equal(readFileSync(join(folder, 'post.deslopped.md'), 'utf8'), 'The rewrite.\n')
})

test('a Path that conflicts with a known constraint is not recommended, and the report says why', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(golden('ai_shaped')))
  const { decision } = markConflict(runDir, { path: 1, reason: 'The house style forbids a closing point the post has not made.' })
  assert.equal(decision.recommended.mix, '2 local + 1 author input')
  assert.match(textOf(report(runDir), 'timeline'), /Conflicts with a known constraint: The house style forbids/)
})

test('check sends the version and the goal to SLOP_API_URL and records the answer', async () => {
  let received
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(raw) }
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' })
      res.end(JSON.stringify(failure(429, 'rate_limited', 120).body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { runDir } = newRun()
    const { decision } = await check(runDir, { env: { SLOP_API_URL: `http://127.0.0.1:${server.address().port}` } })
    assert.equal(received.url, '/api/slop/v1/check')
    assert.deepEqual(received.body, { text: POST, target_p_ai: 0.2 })
    assert.equal(decision.error.code, 'rate_limited')
    assert.equal(decision.error.retry_after, 120)
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------- more manager rules and guards

test('a borderline post gets its one Path recommended', () => {
  const { runDir } = newRun()
  const { decision } = recordCheck(runDir, ok(golden('borderline')))
  assert.equal(decision.action, 'confirm_path')
  assert.equal(decision.recommended.mix, '1 local')
})

test('a human_shaped post under the goal stops at the first Check, and nothing is written', () => {
  const { runDir } = newRun()
  const { decision, output } = recordCheck(runDir, ok(sf323(golden('human_shaped'), { margin: -7.3 })))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'goal_reached')
  assert.equal(output, null)
})

test('score only: the run stops after the first Check', () => {
  const { runDir } = newRun({ scoreOnly: true })
  const { decision } = recordCheck(runDir, ok(golden('ai_shaped')))
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'score_only')
})

test('a failed fidelity check undoes the round and recommends the next Path of the same version', () => {
  const { runDir } = newRun()
  const first = recordCheck(runDir, ok(golden('ai_shaped')))
  startRound(runDir, { path: first.decision.recommended.path })
  const { decision, run } = recordFidelity(runDir, { passed: false, summary: 'A number changed.' })
  assert.equal(decision.reverted, true)
  assert.equal(decision.recommended.mix, '2 local + 1 author input')
  assert.equal(run.current, 0)
})

test('only Paths that do not reach the target are left: the user is asked', () => {
  const { runDir } = newRun()
  const body = golden('ai_shaped')
  const paths = body.paths.map((p) => ({ ...p, reaches_band: false }))
  const { decision } = recordCheck(runDir, ok(sf323({ ...body, paths })))
  assert.equal(decision.action, 'ask_user')
  assert.equal(decision.reason, 'no_path_reaches_target')
})

test('only Paths that do not reach the target are left, non-interactive: the run stops', () => {
  const { runDir } = newRun({ interactive: false })
  const body = golden('ai_shaped')
  const { decision } = recordCheck(runDir, ok({ ...body, paths: body.paths.map((p) => ({ ...p, reaches_band: false })) }))
  assert.equal(decision.action, 'stop')
})

test('budget_exhausted without retry_after still says when to try again', () => {
  const { runDir } = newRun()
  const { decision } = recordCheck(runDir, failure(503, 'budget_exhausted'))
  assert.match(decision.message, /00:00 UTC/)
})

test('an API error is saved in the run folder', () => {
  const { runDir } = newRun()
  recordCheck(runDir, failure(429, 'rate_limited', 60))
  assert.equal(JSON.parse(readFileSync(join(runDir, 'checks', 'v0-error.json'), 'utf8')).error.code, 'rate_limited')
})

test('an API error on a rewrite: the report shows the round as not checked', () => {
  const { runDir } = newRun()
  const first = recordCheck(runDir, ok(golden('ai_shaped')))
  const { write_to } = startRound(runDir, { path: first.decision.recommended.path })
  writeFileSync(write_to, 'The rewrite.\n')
  recordFidelity(runDir, { passed: true })
  recordCheck(runDir, failure(502, 'score_failed'))
  const html = report(runDir)
  assert.doesNotMatch(textOf(html, 'timeline'), /Checking/)
  assert.match(textOf(html, 'timeline'), /Not checked/)
})

test('the report title is the heading of the post, or its source when it has none', () => {
  const { runDir } = newRun()
  recordCheck(runDir, ok(golden('ai_shaped')))
  assert.equal(textOf(report(runDir), 'title'), 'How to make asynchronous communication work')
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  const url = init({ input: 'https://example.com/blog/async-work', runsDir: dir })
  writeFileSync(join(dir, 'post.md'), 'Our Monday standup used to take 45 minutes, and half of the team joined late.\n')
  recordCheck(url.runDir, ok(golden('ai_shaped')))
  setOriginal(url.runDir, { file: join(dir, 'post.md') })
  assert.equal(textOf(report(url.runDir), 'title'), 'async-work')
})

test('a round cannot start past the round limit, or on a Path already tried from the same version', () => {
  const { runDir } = runRounds(1)
  assert.throws(() => startRound(runDir, { path: 1 }), /limit/)
  extendRounds(runDir, { rounds: 1 })
  assert.doesNotThrow(() => startRound(runDir, { path: 1 }))
  const fresh = newRun()
  const first = recordCheck(fresh.runDir, ok(golden('ai_shaped')))
  startRound(fresh.runDir, { path: 1 })
  recordFidelity(fresh.runDir, { passed: false })
  assert.throws(() => startRound(fresh.runDir, { path: 1 }), /tried/)
  assert.ok(first)
})

test('a conflict before the first Check is refused with a clear error', () => {
  const { runDir } = newRun()
  assert.throws(() => markConflict(runDir, { path: 1, reason: 'x' }), /Check the original post first/)
})

test('an answer of 200 that is not a Check stops the run as an internal error', async () => {
  const { runDir } = newRun()
  const fetchImpl = async () => new Response('<html>Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  const { decision } = await check(runDir, { fetchImpl, env: {} })
  assert.equal(decision.error.code, 'internal')
})

// ---------------------------------------------------------------- the URL re-check and the margin rule

test('a URL run checks the skill\'s own copy of the post before round 1, and decides from that Check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  const { runDir } = init({ input: 'https://example.com/blog/async', runsDir: dir })
  recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  writeFileSync(join(dir, 'post.md'), POST)
  setOriginal(runDir, { file: join(dir, 'post.md') })
  assert.throws(() => startRound(runDir, { path: 1 }), /Check the saved text/)
  const { decision, run } = recordCheck(runDir, ok(sf323(golden('borderline'), { margin: 4.7 })))
  assert.equal(decision.recommended.mix, '1 local')
  assert.equal(run.versions.length, 1)
  assert.equal(run.versions[0].p_ai, golden('borderline').p_ai)
})

test('P(AI) unchanged: the round is kept, whatever the margin does', () => {
  const { runDir } = newRun()
  const { run } = roundOne(runDir, sf323(golden('ai_shaped'), { margin: 16.5 }))
  assert.equal(run.rounds[0].outcome, 'kept')
})

// ---------------------------------------------------------------- the word count and the API's 10,000-word limit

const MARKDOWN = [
  '# The title line is not counted',
  '',
  'A post with a [link to a page](https://example.com/a/very/long/path) and an ![image](https://example.com/i.png).',
  '',
  '- **Bold** item',
  '- `code` item',
  '',
  '| Cell one | Cell two |',
  '|---|---|',
  '| a | b |',
  '',
  '[ref]: https://example.com/reference',
].join('\n')

test('word count: markdown, links and the title line count as the API counts them', () => {
  assert.equal(markdownToText(dropTitleLine(MARKDOWN)), 'A post with a link to a page and an .\n\nBold item\ncode item\n\nCell one Cell two\na b')
  assert.equal(postWords(MARKDOWN), 21)
})

test('word count: a short first line without a heading mark is a title, a first sentence is not', () => {
  assert.equal(postWords('A short title\n\nBody text here.'), 3)
  assert.equal(postWords('This first line is a sentence.\n\nBody.'), 7)
  assert.equal(postWords('Only one line here'), 4)
})

/** A fetch that records each call and answers with the given Check. */
function fakeFetch(body) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

const longPost = (words) => `# A long post\n\n${'word '.repeat(words).trim()}\n`

async function checkFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  writeFileSync(join(dir, 'post.md'), content)
  const { runDir } = init({ input: join(dir, 'post.md'), runsDir: join(dir, 'runs') })
  const { calls, fetchImpl } = fakeFetch(golden('ai_shaped'))
  const { decision } = await check(runDir, { fetchImpl, env: {} })
  return { runDir, calls, decision }
}

test('a post over 10,000 words stops before any API call, with a plain message in words', async () => {
  const { runDir, calls, decision } = await checkFile(longPost(12345))
  assert.equal(calls.length, 0)
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'too_long')
  assert.equal(decision.words, 12345)
  assert.equal(decision.message, 'The post has 12,345 words. The API reads posts of 300 to 10,000 words. Shorten it, or check a part of it.')
  assert.equal(runLog(runDir).next.words, 12345)
})

test('a post of exactly 10,000 words goes to the API; one more word is refused', async () => {
  assert.equal((await checkFile(longPost(10000))).calls.length, 1)
  assert.equal((await checkFile(longPost(10001))).calls.length, 0)
})

test('link targets and images carry no words; link text counts', async () => {
  const link = `[a source](https://example.com/${'x'.repeat(200)})`
  const content = `${longPost(9950)}\n${Array(20).fill(link).join(' ')}\n\n![chart](https://example.com/chart.png)\n`
  assert.equal(postWords(content), 9990)
  const { calls } = await checkFile(content)
  assert.equal(calls.length, 1)
  assert.match(calls[0].text, /a source a source/)
  assert.doesNotMatch(calls[0].text, /example\.com/)
  assert.equal((await checkFile(`${longPost(9970)}\n${Array(20).fill(link).join(' ')}\n`)).calls.length, 0)
})

test('a URL run whose own copy is over the limit keeps the API\'s Check of the URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deslop-test-'))
  const { runDir } = init({ input: 'https://example.com/blog/long-post', runsDir: dir })
  recordCheck(runDir, ok(sf323(golden('ai_shaped'), { margin: 12.48 })))
  writeFileSync(join(dir, 'copy.md'), longPost(10500))
  setOriginal(runDir, { file: join(dir, 'copy.md') })
  const { calls, fetchImpl } = fakeFetch(golden('borderline'))
  const { decision } = await check(runDir, { fetchImpl, env: {} })
  assert.equal(calls.length, 0)
  assert.equal(decision.action, 'confirm_path')
  assert.doesNotThrow(() => startRound(runDir, { path: decision.recommended.path }))
  assert.match(textOf(report(runDir), 'banners'), /Your copy of the post has 10,500 words\. The API reads posts of 300 to 10,000 words\./)
})

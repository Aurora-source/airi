import type { ResultRow } from './runner'
import type { Scenario } from './scenarios'

/** The sealed mapping from anonymous letters back to models. It stays out of the page, so the ranking is blind. */
export interface BlindKey {
  seed: number
  scenarios: Record<string, Record<string, string>>
}

/** What the page exports after the user ranked. A lower number is a better answer. */
export interface BlindRanks {
  version: 1
  ranks: Record<string, Record<string, number>>
}

interface PageScene {
  id: string
  category: string
  context?: string
  history: { role: string, content: string }[]
  user: string
  answers: { label: string, text: string, toolCall?: string }[]
}

/** A small seeded generator, so that the same seed always gives the same shuffle. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Builds the blind ranking package.
 *
 * Each scene lists the answers of every model that answered it, in a random order under the letters A, B, C, and so on.
 * Two models that gave the identical text are listed once per model, so that the user cannot tell which letters came from one provider.
 * The page holds the scenes and the answers. The key holds the models. Keep them apart until the ranking is done.
 */
export function buildBlindPackage(scenarios: Scenario[], rows: ResultRow[], seed: number): { html: string, key: BlindKey } {
  const random = mulberry32(seed)
  const key: BlindKey = { seed, scenarios: {} }
  const scenes: PageScene[] = []

  for (const scenario of scenarios) {
    const answers = rows.filter(row => row.scenarioId === scenario.id && row.record.status === 200 && row.record.text.trim() !== '')
    if (answers.length < 2)
      continue
    const shuffled = [...answers]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    key.scenarios[scenario.id] = {}
    scenes.push({
      id: scenario.id,
      category: scenario.category,
      context: scenario.context,
      history: scenario.history,
      user: scenario.user,
      answers: shuffled.map((row, index) => {
        const label = String.fromCharCode(65 + index)
        key.scenarios[scenario.id][label] = row.modelId
        const call = row.record.toolCalls[0]
        return { label, text: row.record.text, toolCall: call ? `${call.name} ${call.arguments}` : undefined }
      }),
    })
  }
  return { html: renderPage(scenes), key }
}

/**
 * Turns a user's ranking into one line per model: the mean rank, scaled from 0 (always first) to 1 (always last),
 * and the number of first places. A scene that the user ranked partly gives the unranked answers the average of the places that remain.
 */
export function scoreBlind(key: BlindKey, ranks: BlindRanks): { modelId: string, scenes: number, meanRank: number, firstPlaces: number }[] {
  const totals = new Map<string, { scenes: number, sum: number, wins: number }>()
  for (const [sceneId, labels] of Object.entries(key.scenarios)) {
    const given = ranks.ranks[sceneId]
    if (!given)
      continue
    const labelList = Object.keys(labels)
    const rankedValues = Object.values(given).filter(value => Number.isFinite(value))
    if (rankedValues.length === 0)
      continue
    const total = labelList.length
    const remaining = (total + rankedValues.length + 1) / 2
    for (const label of labelList) {
      const rank = Number.isFinite(given[label]) ? given[label] : remaining
      const entry = totals.get(labels[label]) ?? { scenes: 0, sum: 0, wins: 0 }
      entry.scenes++
      entry.sum += total === 1 ? 0 : (rank - 1) / (total - 1)
      entry.wins += rank === 1 ? 1 : 0
      totals.set(labels[label], entry)
    }
  }
  return [...totals.entries()]
    .map(([modelId, entry]) => ({ modelId, scenes: entry.scenes, meanRank: entry.sum / entry.scenes, firstPlaces: entry.wins }))
    .sort((a, b) => a.meanRank - b.meanRank)
}

/** The two characters that end a line in JavaScript source. A page script must not hold them raw. */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g')
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g')

/** Data goes into a script tag, so the characters that could end the tag are escaped. */
function embed(value: unknown): string {
  // A backslash, the letter u, and four hex digits: the JSON escape that a script reads as the same character.
  const escapeOf = (code: number) => `${String.fromCharCode(92)}u${code.toString(16).toUpperCase().padStart(4, '0')}`
  return JSON.stringify(value).replace(/</g, escapeOf(0x3C)).replace(LINE_SEPARATOR, escapeOf(0x2028)).replace(PARAGRAPH_SEPARATOR, escapeOf(0x2029))
}

function renderPage(scenes: PageScene[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Persona blind ranking</title>
<style>
  :root { --bg: #fbfaf8; --card: #ffffff; --ink: #1f1d1a; --muted: #6b665e; --line: #e3ded6; --accent: #b4532a; --chip: #f1ebe2; }
  @media (prefers-color-scheme: dark) { :root { --bg: #17150f; --card: #211e17; --ink: #f1ece2; --muted: #a39b8d; --line: #38332a; --accent: #e08b5f; --chip: #2d291f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 96px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: .9rem; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .scene { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .turn { margin: 4px 0; } .turn b { color: var(--muted); font-weight: 600; }
  .user { font-size: 1.05rem; margin-top: 8px; }
  .answer { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin-bottom: 12px; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
  .answer .label { font-weight: 700; color: var(--accent); margin-right: 6px; }
  .chip { display: inline-block; background: var(--chip); color: var(--muted); border-radius: 999px; padding: 0 8px; font-size: .78rem; margin: 0 2px; }
  select { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .note { font-size: .85rem; color: var(--muted); margin-top: 8px; }
  .warn { color: var(--accent); font-size: .85rem; min-height: 1.2em; }
</style>
</head>
<body>
<main>
  <h1>Persona blind ranking</h1>
  <p class="muted">Rank the replies of each scene from 1 (best) to the last place. The page shows no model names. Your ranks are saved in this browser while you work. Press Export when you are done.</p>
  <div class="bar">
    <button id="prev">Previous</button>
    <span id="position" class="muted"></span>
    <button id="next">Next</button>
    <span style="flex:1"></span>
    <button id="export" class="primary">Export ranking</button>
  </div>
  <div id="scene"></div>
  <p class="warn" id="warn"></p>
</main>
<script id="data" type="application/json">${embed(scenes)}</script>
<script>
(function () {
  var scenes = JSON.parse(document.getElementById('data').textContent)
  var storeKey = 'persona-blind-ranking-v1'
  var ranks = {}
  try { ranks = JSON.parse(localStorage.getItem(storeKey) || '{}') } catch (e) { ranks = {} }
  var index = 0
  try { index = Math.min(Number(localStorage.getItem(storeKey + '-index') || 0), scenes.length - 1) } catch (e) { index = 0 }

  function esc(text) { return String(text).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function render(text) {
    // Stage tokens become small chips, so the ranking reads like the stage shows them.
    return esc(text).replace(/&lt;\\|ACT ([\\s\\S]*?)\\|&gt;/g, function (_, json) {
      var label = 'ACT'
      try { var p = JSON.parse(json.replace(/&quot;/g, '"')); var e = typeof p.emotion === 'string' ? p.emotion : (p.emotion && p.emotion.name); label = 'ACT ' + (e || '') + (p.motion ? ' / ' + p.motion : '') } catch (err) { label = 'ACT' }
      return '<span class="chip">' + label + '</span>'
    }).replace(/&lt;\\|DELAY ([0-9.]+)\\|&gt;/g, '<span class="chip">pause $1 s</span>').replace(/\\n/g, '<br>')
  }
  function save() { try { localStorage.setItem(storeKey, JSON.stringify(ranks)); localStorage.setItem(storeKey + '-index', String(index)) } catch (e) { /* storage can be off */ } }

  function show() {
    var scene = scenes[index]
    var mine = ranks[scene.id] || {}
    var html = '<div class="scene"><div class="muted">' + esc(scene.category) + '</div>'
    scene.history.forEach(function (t) { html += '<div class="turn"><b>' + (t.role === 'user' ? 'You' : 'Companion') + ':</b> ' + render(t.content) + '</div>' })
    if (scene.context) html += '<div class="note">' + esc(scene.context) + '</div>'
    html += '<div class="user"><b>You:</b> ' + esc(scene.user) + '</div></div>'
    scene.answers.forEach(function (a) {
      var options = '<option value="">rank</option>'
      for (var r = 1; r <= scene.answers.length; r++) options += '<option value="' + r + '"' + (mine[a.label] === r ? ' selected' : '') + '>' + r + '</option>'
      html += '<div class="answer"><div><span class="label">' + a.label + '</span>' + (a.toolCall ? '<div class="note">called tool: ' + esc(a.toolCall) + '</div>' : '') + render(a.text) + '</div>'
        + '<select data-label="' + a.label + '">' + options + '</select></div>'
    })
    document.getElementById('scene').innerHTML = html
    document.getElementById('position').textContent = 'Scene ' + (index + 1) + ' of ' + scenes.length
    document.querySelectorAll('select').forEach(function (s) {
      s.addEventListener('change', function () {
        var map = ranks[scene.id] || (ranks[scene.id] = {})
        if (s.value) map[s.dataset.label] = Number(s.value); else delete map[s.dataset.label]
        var used = Object.values(map), dupes = used.length !== new Set(used).size
        document.getElementById('warn').textContent = dupes ? 'Two replies share a rank. Give each reply its own place.' : ''
        save()
      })
    })
    save()
  }

  document.getElementById('prev').onclick = function () { if (index > 0) { index--; show() } }
  document.getElementById('next').onclick = function () { if (index < scenes.length - 1) { index++; show() } }
  document.getElementById('export').onclick = function () {
    var blob = new Blob([JSON.stringify({ version: 1, ranks: ranks }, null, 2)], { type: 'application/json' })
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'persona-blind-ranks.json'; a.click()
  }
  show()
})()
</script>
</body>
</html>
`
}

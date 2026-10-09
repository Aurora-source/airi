import type { Sample } from './runner'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRICES } from './corpus'
import { spokenText, summarize } from './protocol'
import { aggregate, worksheet } from './report'
import { THINKING } from './thinking'
import { THINKING_DIALOGUES } from './thinking-scenes'
import { replayVoiceText } from './voice'

function write(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

function variantOf(row: Sample): string {
  return `${row.model}/${row.reasoningEffort}/${row.path}`
}

/** Keeps all delivered turns, including malformed ACT, only when every primary variant completed the same scene and repeat. */
function matchedPrimaryRows(samples: Sample[]): Sample[] {
  const variants = new Set(samples.filter(row => row.scenario === 'latency').map(variantOf))
  const personas = samples.filter(row => row.scenario.startsWith('persona/') && variants.has(variantOf(row)))
  const runs = new Set(personas.map(row => row.campaignRunId))
  const matched: Sample[] = []
  for (const run of runs) {
    for (const dialogue of THINKING_DIALOGUES) {
      const rows = personas.filter(row => row.campaignRunId === run && row.scenario.split('/')[1] === dialogue.id)
      const complete = [...variants].every(variant => dialogue.turns.every((_, index) => rows.filter(row => variantOf(row) === variant && row.scenario === `persona/${dialogue.id}/${index}` && row.status === 200 && row.done && row.usage && !row.error).length === 1))
      if (complete)
        matched.push(...rows)
    }
  }
  return matched
}

function groups(rows: Sample[], byScenario = false) {
  const keyOf = (row: Sample) => `${variantOf(row)}${byScenario ? `/${row.scenario}` : ''}`
  const keys = [...new Set(rows.map(keyOf))]
  return keys.map((key) => {
    const selected = rows.filter(row => keyOf(row) === key)
    const metric = (read: (row: Sample) => number | undefined) => {
      const values = selected.map(read).filter((value): value is number => value !== undefined && Number.isFinite(value))
      return values.length ? summarize(values) : undefined
    }
    const costNano = selected.reduce((sum, row) => sum + (row.costNano ?? 0), 0)
    const accounted = selected.filter(row => row.costNano !== undefined && row.usage)
    return {
      key,
      model: selected[0].model,
      effort: selected[0].reasoningEffort,
      path: selected[0].path,
      ...(byScenario ? { scenario: selected[0].scenario } : {}),
      n: selected.length,
      accountedSamples: accounted.length,
      unknownUsageSamples: selected.length - accounted.length,
      meaningful: selected.filter(row => row.firstTextMs !== undefined).length,
      firstByteMs: metric(row => row.firstByteMs),
      firstTextMs: metric(row => row.firstTextMs),
      firstSentenceMs: metric(row => row.firstSentenceMs),
      totalMs: metric(row => row.totalMs),
      wordCount: metric(row => spokenText(row.text).trim().split(/\s+/).filter(Boolean).length),
      inputTokens: metric(row => row.usage?.input),
      generatedTokens: metric(row => row.usage?.output),
      thinkingTokens: metric(row => row.usage?.thinking),
      knownCostUsd: costNano / 1e9,
      meanKnownCostUsd: accounted.length ? costNano / accounted.length / 1e9 : undefined,
      knownCostPerMeaningfulUsd: selected.some(row => row.firstTextMs !== undefined) ? costNano / selected.filter(row => row.firstTextMs !== undefined).length / 1e9 : undefined,
      zeroThinking: selected.filter(row => row.usage?.thinking === 0).length,
      thinkingUsd: selected.reduce((sum, row) => sum + (row.usage?.thinking ?? 0) * PRICES[row.model].output / 1e6, 0),
    }
  })
}

/**
 * Derives comparable results and blinded review files without provider calls.
 * Reuses the prior benchmark's persona checks and upstream voice chunker.
 *
 * Call stack:
 * thinkingReport -> aggregate / worksheet -> replayVoiceText -> groups -> local evidence files
 */
export async function thinkingReport(directory: string): Promise<void> {
  const samples: Sample[] = readFileSync(join(directory, 'samples.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const base = aggregate(samples, THINKING_DIALOGUES)
  const voices: (Awaited<ReturnType<typeof replayVoiceText>> & { id: string, model: string, effort?: string, scenario: string, path: string, firstTextMs?: number, totalMs: number })[] = []
  for (const sample of samples.filter(row => row.textChunks))
    voices.push({ id: sample.id, model: sample.model, effort: sample.reasoningEffort, scenario: sample.scenario, path: sample.path, firstTextMs: sample.firstTextMs, totalMs: sample.totalMs, ...await replayVoiceText(sample.textChunks!, sample.totalMs) })
  const ledger: { ceilingNano: number, halted: boolean, entries: { status: string, costNano?: number, reservedNano: number }[] } = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'))
  const spentNano = ledger.entries.reduce((sum, row) => sum + (row.costNano ?? 0), 0)
  const exposureNano = ledger.entries.reduce((sum, row) => sum + (row.status === 'settled' ? row.costNano ?? 0 : row.reservedNano), 0)
  if (spentNano !== samples.reduce((sum, row) => sum + (row.costNano ?? 0), 0))
    throw new Error('Sample costs and ledger settlements disagree')
  const initialTransportIds = new Set<string>()
  const originalPhase = join(directory, 'completed-v2-latency.json')
  if (existsSync(originalPhase)) {
    const completed: { campaignRunId: string, warmedInProcess?: boolean } = JSON.parse(readFileSync(originalPhase, 'utf8'))
    // The initial V2 matrix omitted same-process warmups. Reclassify its first block without changing paid samples or accounting.
    if (completed.warmedInProcess !== true) {
      const seen = new Set<string>()
      for (const row of samples.filter(row => row.scenario === 'latency' && row.campaignRunId === completed.campaignRunId)) {
        const variant = `${row.model}/${row.reasoningEffort}/${row.path}`
        if (!seen.has(variant)) {
          initialTransportIds.add(row.id)
          seen.add(variant)
        }
      }
    }
  }
  const warmLatency = samples.filter(row => row.scenario === 'latency' && !row.cold && !initialTransportIds.has(row.id) && row.status === 200 && row.done && row.usage && !row.error)
  const latency = groups(warmLatency)
  const persona = groups(samples.filter(row => row.scenario.startsWith('persona/')))
  const matched = matchedPrimaryRows(samples)
  const matchedIds = new Set(matched.map(row => row.id))
  const matchedPrimaryPersona = groups(matched)
  const primaryVariants = new Set(latency.map(row => row.key))
  const unmatchedPrimaryPersonaIds = samples.filter(row => row.scenario.startsWith('persona/') && primaryVariants.has(variantOf(row)) && !matchedIds.has(row.id)).map(row => row.id)
  const monthly = [...matchedPrimaryPersona, ...persona.filter(row => !primaryVariants.has(row.key))].map((row) => {
    const price = PRICES[row.model]
    const generated = row.generatedTokens?.mean ?? 0
    const perTurn = (input: number) => (input * price.input + generated * price.output) / 1e6
    return {
      model: row.model,
      effort: row.effort,
      n: row.n,
      measuredGeneratedTokens: generated,
      measuredThinkingTokens: row.thinkingTokens?.mean,
      measuredKnownCostPer1000AccountedTurnsUsd: (row.meanKnownCostUsd ?? 0) * 1000,
      planning: [1000, 4000, 10000].map(inputTokens => ({ inputTokens, costPer1000TurnsUsd: perTurn(inputTokens) * 1000, monthly30TurnsPerDayUsd: perTurn(inputTokens) * 900, monthly120TurnsPerDayUsd: perTurn(inputTokens) * 3600, turnsWithin10Usd: Math.floor(10 / perTurn(inputTokens)), turnsWithin15Usd: Math.floor(15 / perTurn(inputTokens)) })),
      january2027Multiplier: /3\.[678]-flash$/.test(row.model) ? 2 : 1,
    }
  })
  const warmIds = new Set(warmLatency.map(row => row.id))
  const voiceLatency = latency.map((row) => {
    const selected = voices.filter(voice => warmIds.has(voice.id) && `${voice.model}/${voice.effort}/${voice.path}` === row.key)
    const values = selected.filter(voice => voice.firstChunkAtMs !== undefined).map(voice => voice.firstChunkAtMs!)
    return { key: row.key, firstUsableChunkMs: values.length ? summarize(values) : undefined, missingChunkSamples: row.n - values.length }
  })
  write(directory, 'results.json', { ...base, schemaVersion: 2, costs: { v1Usd: 0.340722225, v2KnownUsd: spentNano / 1e9, v2WorstCaseUsd: exposureNano / 1e9, combinedKnownUsd: (spentNano + 340722225) / 1e9, combinedWorstCaseUsd: (exposureNano + 340722225) / 1e9, v2CeilingUsd: ledger.ceilingNano / 1e9, unresolvedExposureUsd: (exposureNano - spentNano) / 1e9, accountingComplete: ledger.entries.every(row => row.status === 'settled'), halted: ledger.halted }, matrix: groups(samples), latency, cold: samples.filter(row => row.cold || initialTransportIds.has(row.id)).map(row => ({ ...row, coldClassification: initialTransportIds.has(row.id) ? 'initial-matrix-transport' : 'explicit-warmup' })), persona, matchedPrimaryPersona, matchedPrimaryPersonaIds: [...matchedIds], unmatchedPrimaryPersonaIds, voiceLatency, direct: groups(samples.filter(row => row.scenario === 'direct-comparison')), contextGroups: groups(samples.filter(row => row.scenario.startsWith('context/')), true), humanReviewComplete: false, physicalAudioMeasured: false })
  write(directory, 'voice-text-replay.json', { mode: 'Measured text arrivals replayed through existing chunkTtsInput after strict ACT removal', physicalAudioMeasured: false, rows: voices })
  write(directory, 'monthly-costs.json', { assumptions: { cachedFraction: 0, measuredGenerationIncludesThinking: true, turns: 'One generation per user turn. Add tool continuation, retries, STT, and other admitted inference separately.', creditsDiscounted: false, localTtsMeteredCostUsd: 0 }, rows: monthly })
  write(directory, 'prices.json', { capturedAt: '2026-10-09', source: 'https://ai.google.dev/gemini-api/docs/pricing', standard: PRICES, unit: 'USD per million tokens', outputIncludesThinking: true, futureFlashPricesDoubleAt: '2027-01-01' })
  write(directory, 'thinking-capabilities.json', { capturedAt: '2026-10-09', sources: ['https://ai.google.dev/gemini-api/docs/generate-content/thinking', 'https://ai.google.dev/gemini-api/docs/thinking', 'https://ai.google.dev/gemini-api/docs/openai'], levels: THINKING, disabledThinking: false, minimalGuaranteesZeroTokens: false, nativeParameter: 'generationConfig.thinkingConfig.thinkingLevel', openaiParameter: 'reasoning_effort', numericBudget: 'Not recommended for Gemini 3. Do not combine with thinkingLevel. No numeric-budget probes were dispatched.', unsupported: ['All listed Gemini 3 models: true off/none', '3.7 Flash and 3.8 Flash: minimal'], generationAccess: [...new Set(samples.filter(row => row.status === 200 && row.done).map(row => `${row.model}/${row.reasoningEffort}`))] })
  const blind = worksheet(matched, THINKING_DIALOGUES)
  const markdown = blind.markdown.replace('naturalness, warmth, consistency, humor, emotional nuance, and appropriate length', 'naturalness, personality, emotional nuance, humor, consistency, conciseness, conversational flow, and overall preference').replace('| Variant | Naturalness | Warmth | Consistency | Humor | Nuance | Length | Preference |', '| Variant | Naturalness | Personality | Nuance | Humor | Consistency | Conciseness | Flow | Preference |').replace('| --- | --- | --- | --- | --- | --- | --- | --- |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |').replace(/\| ([A-Z]) \| \| \| \| \| \| \| \|/g, '| $1 | | | | | | | | |')
  writeFileSync(join(directory, 'human-review.md'), markdown)
  write(directory, 'human-review-key.json', blind.key)
  const retained = worksheet(samples, THINKING_DIALOGUES)
  writeFileSync(join(directory, 'retained-conversations.md'), retained.markdown)
  write(directory, 'retained-conversations-key.json', retained.key)
  const csv = ['model,effort,n,meaningful,first_text_p50_ms,first_text_p95_ms,total_p50_ms,mean_thinking_tokens,mean_known_cost_usd', ...latency.map(row => [row.model, row.effort, row.n, row.meaningful, row.firstTextMs?.p50, row.firstTextMs?.p95 ?? '', row.totalMs?.p50, row.thinkingTokens?.mean, row.meanKnownCostUsd].join(','))]
  writeFileSync(join(directory, 'comparison.csv'), `${csv.join('\n')}\n`)
  console.info(JSON.stringify({ samples: samples.length, v2KnownUsd: spentNano / 1e9, v2WorstCaseUsd: exposureNano / 1e9, combinedKnownUsd: (spentNano + 340722225) / 1e9, unresolvedExposureUsd: (exposureNano - spentNano) / 1e9 }))
}

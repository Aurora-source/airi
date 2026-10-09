import type { Dialogue } from './corpus'
import type { Sample } from './runner'

import { runChecks } from '../persona/checks'
import { DIALOGUES, fingerprint, SYSTEM } from './corpus'
import { summarize } from './protocol'

/** Generates descriptive results from retained samples. Cold starts and different workload classes remain separate. */
export function aggregate(samples: Sample[], dialogues: readonly Dialogue[] = DIALOGUES) {
  const groups = new Map<string, Sample[]>()
  for (const sample of samples.filter(sample => ['latency', 'optimization'].includes(sample.scenario) && !sample.cold && sample.status === 200 && sample.done && sample.usage && !sample.error)) {
    const key = `${sample.model}/${sample.path}/${sample.reasoningEffort}`
    const group = groups.get(key)
    if (group)
      group.push(sample)
    else
      groups.set(key, [sample])
  }
  const latency = [...groups].map(([group, rows]) => {
    const metric = (select: (sample: Sample) => number | undefined) => {
      const values = rows.map(select).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)
      return values.length ? summarize(values) : undefined
    }
    return {
      group,
      model: rows[0].model,
      path: rows[0].path,
      n: rows.length,
      meaningfulTextSamples: rows.filter(row => row.firstTextMs !== undefined).length,
      malformedOrAbsentSpokenText: rows.filter(row => row.firstTextMs === undefined).length,
      firstByte: metric(sample => sample.firstByteMs),
      firstText: metric(sample => sample.firstTextMs),
      firstSentence: metric(sample => sample.firstSentenceMs),
      total: metric(sample => sample.totalMs),
      preparation: metric(sample => sample.preparationMs),
      headers: metric(sample => sample.headersMs),
      contextAssembly: metric(sample => sample.contextAssemblyMs),
      providerSelectionAndBudget: metric(sample => sample.providerSelectionAndBudgetMs),
      gatewayProviderFirstByte: metric(sample => sample.gatewayProviderFirstByteMs),
      gatewayBeforeProvider: metric(sample => sample.gatewayBeforeProviderMs),
      // Includes ACT and other control payloads. Stream delivery does not expose the provider's internal generation clock.
      nonThinkingCompletionTokensPerSecondApprox: metric(sample => sample.usage && sample.firstByteMs !== undefined && sample.totalMs > sample.firstByteMs ? (sample.usage.output - sample.usage.thinking) * 1000 / (sample.totalMs - sample.firstByteMs) : undefined),
      meanInputTokens: rows.reduce((sum, row) => sum + (row.usage?.input ?? 0), 0) / rows.length,
      meanOutputTokens: rows.reduce((sum, row) => sum + (row.usage?.output ?? 0), 0) / rows.length,
      meanCachedTokens: rows.reduce((sum, row) => sum + (row.usage?.cached ?? 0), 0) / rows.length,
      meanCostUsd: rows.reduce((sum, row) => sum + (row.costNano ?? 0), 0) / rows.length / 1e9,
    }
  })
  const mechanical = samples.filter(sample => sample.scenario.startsWith('persona/')).map((sample) => {
    const [, scene, turn] = sample.scenario.split('/')
    const dialogue = dialogues.find(dialogue => dialogue.id === scene)!
    const index = Number(turn)
    return {
      id: sample.id,
      model: sample.model,
      scene,
      turn: index,
      effort: sample.reasoningEffort,
      checks: runChecks({ id: sample.scenario, category: 'casual', history: [], user: dialogue.turns[index], shape: scene === 'complex-detail' && index === 1 ? 'long' : 'short', note: 'Synthetic multi-turn evaluation. Human character review remains separate.' }, {
        scenarioId: sample.scenario,
        modelId: sample.model,
        text: sample.text,
        status: sample.status,
        reasoningChannel: sample.reasoningChannel,
        toolCalls: sample.calls.map(call => ({ name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' })),
      }, SYSTEM),
    }
  })
  return {
    schemaVersion: 1,
    sampleCount: samples.length,
    knownCostUsd: samples.reduce((sum, row) => sum + (row.costNano ?? 0), 0) / 1e9,
    unknownUsageSamples: samples.filter(row => !row.usage).length,
    failures: samples.filter(row => row.error || !row.usage || !row.done || (row.calls.length === 0 && row.firstTextMs === undefined)),
    latency,
    cold: samples.filter(row => row.cold),
    contexts: samples.filter(row => row.scenario.startsWith('context/')),
    capabilities: samples.filter(row => row.scenario.startsWith('capability/')),
    concurrency: samples.filter(row => row.scenario === 'concurrency'),
    airiEnvelope: samples.filter(row => row.scenario === 'airi-envelope'),
    mechanical,
    limitations: ['Empirical p95 requires twenty samples and remains unstable at that size.', 'First sentence is a text punctuation boundary, not measured TTS readiness.', 'Completion-rate estimates include control tokens and measure stream delivery, not provider computation.', 'No microphone, STT, Mura TTS, playback, or physical lip-sync latency is inferred.', 'Provider computation cannot be separated from network latency without provider telemetry.'],
  }
}

/** Generates dialogue-only human review material. The separate key reveals model and effort after scoring. */
export function worksheet(samples: Sample[], dialogues: readonly Dialogue[] = DIALOGUES): { markdown: string, key: unknown } {
  const personas = samples.filter(sample => sample.scenario.startsWith('persona/'))
  const variantOf = (sample: Sample) => `${sample.model}|${sample.reasoningEffort}|${sample.path}|${sample.campaignRunId ?? 'fixture'}`
  const variants = [...new Set(personas.map(variantOf))].toSorted((a, b) => fingerprint(a).localeCompare(fingerprint(b)))
  const labels = new Map(variants.map((variant, index) => [variant, String.fromCharCode(65 + index)]))
  const lines = ['# Blinded character review', '', 'Score each dialogue from 1 to 5 for naturalness, warmth, consistency, humor, emotional nuance, and appropriate length.', 'Record correction, memory, uncertainty, boundary, and injection failures separately.', 'Keep the key closed until scoring is complete. Format checks do not measure charm.', '', '| Variant | Naturalness | Warmth | Consistency | Humor | Nuance | Length | Preference |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const label of labels.values())
    lines.push(`| ${label} | | | | | | | |`)
  for (const dialogue of dialogues) {
    for (const variant of variants) {
      const rows = personas.filter(row => variantOf(row) === variant && row.scenario.split('/')[1] === dialogue.id).toSorted((a, b) => Number(a.scenario.split('/')[2]) - Number(b.scenario.split('/')[2]))
      if (!rows.length)
        continue
      lines.push('', `## ${dialogue.id}: variant ${labels.get(variant)}`, '')
      if (rows.length < dialogue.turns.length || rows.some(row => row.error || !row.done))
        lines.push('Incomplete conversation. Do not score this dialogue. Retained attempts appear below.', '')
      for (const unit of dialogue.units ?? [])
        lines.push(`Synthetic ${unit.kind} evidence: ${unit.message.content}`, '')
      for (const row of rows) {
        const reply = row.error || !row.done ? '[No completed response. Delivery failed before a complete reply.]' : row.text
        lines.push(`User: ${dialogue.turns[Number(row.scenario.split('/')[2])]}`, '', `Mura: ${reply}`, '')
      }
    }
  }
  return { markdown: `${lines.join('\n')}\n`, key: Object.fromEntries(variants.map(variant => [labels.get(variant)!, variant])) }
}

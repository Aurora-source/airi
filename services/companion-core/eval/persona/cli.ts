#!/usr/bin/env node
import type { ModelFacts, ModelSummary } from './aggregate'
import type { BlindKey, BlindRanks } from './blind'
import type { Judgment } from './judge'
import type { ResultRow } from './runner'

import process from 'node:process'

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { INFERENCE_TOKEN_SECRET } from '../../src/auth/credentials'
import { DpapiSecretStore } from '../../src/auth/secret-store'
import { loadConfig, resolveHome, resolveModel } from '../../src/config/config'
import { ProbeStore, withProbedCapabilities } from '../../src/probe/store'
import { openDatabase } from '../../src/store/database'
import { passesConversationGates, rankConversation, rankReasoning, summarize } from './aggregate'
import { buildBlindPackage, scoreBlind } from './blind'
import { GatewayClient } from './client'
import { chooseJudge, judgeAnswer } from './judge'
import { buildSystemPrompt } from './prompt'
import { runModel } from './runner'
import { SCENARIOS } from './scenarios'

const USAGE = `Usage: persona <command> --out <directory>

Commands:
  run         Run the scenes on the models, through the gateway. Resumes when results.jsonl exists.
              --models a,b,c   Models of the alias chain. Default: the whole chain.
              --alias <name>   Alias that holds the models. Default: companion-eval.
              --parallel <n>   Models that run at the same time. Default: 3.
              --limit <n>      Only the first n scenes.
              --card <file>    Persona text file that replaces AIRI's default character.
  judge       Score each answer with a judge from another provider. Resumes.
              --judges a,b     Judge models in order of preference. Default: groq-oss-120b,gemini-flash-lite.
  report      Write report.md, summary.json, blind-ranking.html, and key.json.
              --seed <n>       Seed of the blind shuffle.
  score-blind Score the ranking that the page exported. --ranks <file>

The gateway must run. The inference token comes from the protected store and is never printed.`

function readJsonl<T>(path: string): T[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
    : []
}

function append(path: string, value: unknown) {
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}

/** Runs async jobs with at most `limit` at once. */
async function pool<T>(items: T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift())
      await job(item)
  }))
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      models: { type: 'string' },
      alias: { type: 'string' },
      parallel: { type: 'string' },
      limit: { type: 'string' },
      card: { type: 'string' },
      judges: { type: 'string' },
      seed: { type: 'string' },
      ranks: { type: 'string' },
    },
  })
  const [command] = positionals
  if (!command || !values.out) {
    console.info(USAGE)
    process.exitCode = command ? 1 : 0
    return
  }
  const out = values.out
  mkdirSync(out, { recursive: true })
  const resultsPath = join(out, 'results.jsonl')
  const judgmentsPath = join(out, 'judgments.jsonl')

  const config = await loadConfig()
  const alias = values.alias ?? 'companion-eval'
  const chain = config.aliases[alias]?.chain
  if (!chain)
    throw new Error(`Alias "${alias}" is not configured.`)
  const providerOf = (modelId: string) => config.models[modelId]?.provider ?? modelId

  const cardText = values.card ? readFileSync(values.card, 'utf8') : undefined
  const systemPrompt = buildSystemPrompt(cardText)
  const scenarios = values.limit ? SCENARIOS.slice(0, Number(values.limit)) : SCENARIOS

  const store = new DpapiSecretStore(join(resolveHome(), 'secrets'))
  const token = await store.read(INFERENCE_TOKEN_SECRET)
  if (!token)
    throw new Error('No inference token exists. Run "companion-core init" first.')
  const client = new GatewayClient({ baseURL: `http://127.0.0.1:${config.port}/`, token })

  switch (command) {
    case 'run': {
      const models = values.models ? values.models.split(',') : chain
      const done = new Set(readJsonl<ResultRow>(resultsPath).filter(row => row.record.status === 200).map(row => `${row.scenarioId}|${row.modelId}`))
      writeFileSync(join(out, 'meta.json'), JSON.stringify({ startedAt: new Date().toISOString(), systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), scenes: scenarios.length, models, alias, customCard: Boolean(cardText) }, null, 2))
      await pool(models, Number(values.parallel ?? 3), async (modelId) => {
        await runModel({
          client,
          alias,
          modelId,
          scenarios,
          systemPrompt,
          done,
          onRow: (row) => {
            append(resultsPath, row)
            const failed = row.checks.filter(check => !check.pass).map(check => check.id)
            console.info(`${modelId.padEnd(22)} ${row.scenarioId.padEnd(14)} HTTP ${row.record.status} ${row.record.firstByteMs ?? '-'}ms ${failed.length === 0 ? 'ok' : `failed: ${failed.join(',')}`}${row.waitedMs > 0 ? ` (waited ${Math.round(row.waitedMs / 1000)}s)` : ''}`)
          },
        })
      })
      return
    }

    case 'judge': {
      const judges = (values.judges ?? 'groq-oss-120b,gemini-flash-lite').split(',')
      const rows = readJsonl<ResultRow>(resultsPath)
      const judged = new Set(readJsonl<Judgment>(judgmentsPath).map(judgment => `${judgment.scenarioId}|${judgment.modelId}`))
      const todo = rows.filter(row => !judged.has(`${row.scenarioId}|${row.modelId}`))
      // One queue per judge model, because each judge has its own rate limits.
      const byJudge = new Map<string, ResultRow[]>()
      for (const row of todo) {
        const judge = chooseJudge(row.modelId, providerOf, judges)
        byJudge.set(judge, [...(byJudge.get(judge) ?? []), row])
      }
      await pool([...byJudge.entries()], byJudge.size, async ([judge, queue]) => {
        for (const row of queue) {
          const scenario = scenarios.find(candidate => candidate.id === row.scenarioId)
          if (!scenario)
            continue
          const judgment = await judgeAnswer(client, `${alias}:${judge}`, judge, scenario, row.record)
          if (judgment) {
            append(judgmentsPath, judgment)
            console.info(`judged ${row.modelId.padEnd(22)} ${row.scenarioId.padEnd(14)} by ${judge}: ${judgment.overall}`)
          }
          else {
            console.info(`judge ${judge} gave no usable scores for ${row.modelId} ${row.scenarioId}`)
          }
        }
      })
      return
    }

    case 'report': {
      const rows = readJsonl<ResultRow>(resultsPath)
      const judgments = readJsonl<Judgment>(judgmentsPath)
      const db = openDatabase(config.store.path ?? join(resolveHome(), 'companion-core.sqlite'))
      const probes = new ProbeStore(db, Date.now)
      const modelIds = [...new Set(rows.map(row => row.modelId))]
      const facts: ModelFacts[] = modelIds.flatMap((id) => {
        const model = resolveModel(config, id)
        if (!model)
          return []
        const capabilities = withProbedCapabilities(model.capabilities, probes.get(id))
        return [{ id, provider: model.providerName, contextWindow: capabilities.maxPrompt ?? capabilities.contextWindow, rpd: model.limits.rpd, tpd: model.limits.tpd, tpm: model.limits.tpm, structuredOutput: capabilities.structuredOutput }]
      })
      db.close()
      const summaries = summarize(rows, judgments, facts, scenarios.length)
      writeFileSync(join(out, 'summary.json'), JSON.stringify(summaries, null, 2))
      writeFileSync(join(out, 'report.md'), renderReport(summaries, rows.length))

      const { html, key } = buildBlindPackage(scenarios, rows, Number(values.seed ?? Date.now() % 100_000))
      writeFileSync(join(out, 'blind-ranking.html'), html)
      writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 2))
      console.info(renderReport(summaries, rows.length))
      console.info(`\nBlind ranking page: ${join(out, 'blind-ranking.html')}\nSealed key (do not open before ranking): ${join(out, 'key.json')}`)
      return
    }

    case 'score-blind': {
      if (!values.ranks)
        throw new Error('score-blind needs --ranks <file>.')
      const key = JSON.parse(readFileSync(join(out, 'key.json'), 'utf8')) as BlindKey
      const ranks = JSON.parse(readFileSync(values.ranks, 'utf8')) as BlindRanks
      console.info('model                  scenes  meanRank(0 best, 1 worst)  firstPlaces')
      for (const score of scoreBlind(key, ranks))
        console.info(`${score.modelId.padEnd(22)} ${String(score.scenes).padStart(6)}  ${score.meanRank.toFixed(3).padStart(24)}  ${String(score.firstPlaces).padStart(11)}`)
      return
    }

    default:
      console.info(USAGE)
      process.exitCode = 1
  }
}

function pct(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value * 100)}%`
}

function renderReport(summaries: ModelSummary[], rowCount: number): string {
  const lines = [`# Persona benchmark`, '', `${summaries.length} models, ${SCENARIOS.length} scenes, ${rowCount} answers.`, '']
  lines.push('| model | persona | judge | auto | ACT | tools | failed | first byte | total | turns/day | prompt tokens |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const summary of rankConversation(summaries)) {
    lines.push(`| ${summary.modelId}${passesConversationGates(summary) ? '' : ' (gate)'} | ${summary.personaScore.toFixed(1)} | ${summary.judge ? summary.judge.overall.toFixed(2) : '-'} | ${pct(summary.autoPassRate)} | ${pct(summary.actCorrectness)} | ${pct(summary.toolCorrectness)} | ${pct(summary.failureRate)} | ${summary.firstByteMs ?? '-'} ms | ${summary.totalMs ?? '-'} ms | ${summary.turnsPerDay ?? '-'} | ${summary.meanPromptTokens ? Math.round(summary.meanPromptTokens) : '-'} |`)
  }
  lines.push('', '`(gate)` marks a model that fails a basic gate: ACT tokens, tool use, or too many failed scenes.', '', '## Conversation order by persona score', '')
  lines.push(rankConversation(summaries).map((summary, index) => `${index + 1}. ${summary.modelId}`).join('\n'))
  lines.push('', '## Reasoning order (structure, tools, reliability, capacity, speed)', '')
  lines.push(rankReasoning(summaries).map((summary, index) => `${index + 1}. ${summary.modelId}`).join('\n'))
  lines.push('', '## Check pass rates', '')
  for (const summary of summaries)
    lines.push(`- **${summary.modelId}**: ${Object.entries(summary.perCheck).map(([id, rate]) => `${id} ${pct(rate)}`).join(', ')}`)
  return `${lines.join('\n')}\n`
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'persona failed.')
  process.exitCode = 1
})

import type { Model } from './protocol'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Official supported levels. Minimal is a requested effort, never a guarantee of zero billed thinking. */
export const THINKING: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'gemini-3.1-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.7-flash': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
})

/** Rejects undocumented levels and missing generation metadata before financial reservation or network dispatch. */
export function assertThinking(models: Model[], model: string, effort: string): void {
  if (!models.some(item => item.name === `models/${model}` && item.supportedGenerationMethods.includes('generateContent')))
    throw new Error('Model capability metadata mismatch')
  if (!THINKING[model]?.includes(effort))
    throw new Error('Unsupported thinking setting. No substitution is allowed.')
}

/** Rotates complete blocks and reverses alternate cycles. Each position receives every configuration. */
export function counterbalanced<T>(rows: readonly T[], round: number): T[] {
  const cycle = Math.floor(round / rows.length)
  const source = cycle % 2 ? [...rows].reverse() : [...rows]
  return source.map((_, index) => source[(index + round) % source.length])
}

/** Binds one immutable campaign identity and creates each phase marker exclusively. Interrupted phases cannot silently repeat. */
export function campaign(directory: string, id: string, phase: string): void {
  const path = join(directory, 'campaign.json')
  if (existsSync(path)) {
    const prior: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!prior || typeof prior !== 'object' || !('id' in prior) || prior.id !== id)
      throw new Error('Campaign identity mismatch')
  }
  else {
    writeFileSync(path, `${JSON.stringify({ id, ceilingUsd: 5, priorCampaignUsd: 0.340722225, createdAt: new Date().toISOString(), authorization: 'Explicit user total V2 allowance of USD 5 on 2026-10-09' }, null, 2)}\n`, { flag: 'wx' })
  }
  const started = join(directory, `started-v2-${phase}.json`)
  if (existsSync(started))
    throw new Error('This campaign phase already started. Repeated paid work is prohibited.')
  writeFileSync(started, `${JSON.stringify({ campaign: id, phase, at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
}

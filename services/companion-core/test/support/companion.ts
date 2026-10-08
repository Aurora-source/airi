import type { RunningGateway } from '../../src'
import type { MemoryPorts } from '../../src/companion/memory'
import type { TurnIdentity } from '../../src/companion/turn-identity'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig, startGateway } from '../../src'
import { CompanionRuntime } from '../../src/companion/runtime'
import { AIRI_CHARACTER_HEADER, AIRI_ROUND_HEADER, AIRI_SESSION_HEADER } from '../../src/companion/turn-identity'
import { ALLOWED_ORIGIN, authHeaders, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, TEST_PROVIDER_KEY } from './harness'

export interface CompanionHarness {
  gateway: RunningGateway
  companion: CompanionRuntime
  logs: string[]
  reports: string[]
  directory: string
  close: () => Promise<void>
}

/**
 * Starts a gateway with a real companion runtime: a memory worker on a temporary SQLite file, and no server channel.
 * `raw` overrides the configuration. The fake provider sits behind alias `companion-chat`.
 */
export async function startCompanionGateway(providerBaseURL: string, raw: Record<string, unknown> = {}, options: { memoryPorts?: MemoryPorts, now?: () => number } = {}): Promise<CompanionHarness> {
  const directory = mkdtempSync(join(tmpdir(), 'companion-memory-'))
  const logs: string[] = []
  const reports: string[] = []
  const config = parseConfig({
    port: 0,
    store: { path: ':memory:' },
    allowedOrigins: [ALLOWED_ORIGIN],
    providers: { fake: { baseURL: providerBaseURL, keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'real-model-1', capabilities: { contextWindow: 128_000, images: true, structuredOutput: true } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
    ...raw,
    memory: { path: join(directory, 'memory', 'memory.sqlite'), ...(raw.memory as Record<string, unknown> | undefined) },
  })
  const companion = await CompanionRuntime.open({ config, home: directory, channel: false, memoryPorts: options.memoryPorts, now: options.now, report: line => reports.push(line) })
  const gateway = await startGateway({
    config,
    credentials: { inference: TEST_INFERENCE_TOKEN, ops: TEST_OPS_TOKEN },
    providerKeys: new Map([['provider-fake', TEST_PROVIDER_KEY]]),
    writeLog: line => logs.push(line),
    companion,
    backupDirectory: join(directory, 'backups'),
  })
  return {
    gateway,
    companion,
    logs,
    reports,
    directory,
    close: async () => {
      await gateway.close()
      await companion.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export function identityHeaders(identity: TurnIdentity): Record<string, string> {
  return {
    ...authHeaders(),
    [AIRI_SESSION_HEADER]: identity.sessionId,
    [AIRI_ROUND_HEADER]: identity.roundId,
    [AIRI_CHARACTER_HEADER]: identity.characterId,
  }
}

/** Polls `read` until `check` passes. Background ingestion finishes after the response ended. */
export async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  let value = await read()
  while (!check(value)) {
    if (performance.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs} ms: ${JSON.stringify(value).slice(0, 500)}`)
    await new Promise(resolve => setTimeout(resolve, 25))
    value = await read()
  }
  return value
}

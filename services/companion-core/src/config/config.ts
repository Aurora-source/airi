import type { InferOutput } from 'valibot'

import process from 'node:process'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import * as v from 'valibot'

/** The gateway holds provider keys, so it never listens outside this loopback address. */
export const LOOPBACK_HOST = '127.0.0.1'

const providerSchema = v.object({
  /** Base URL of an OpenAI-compatible API, with a trailing slash, for example `https://api.groq.com/openai/v1/`. */
  baseURL: v.pipe(v.string(), v.url(), v.endsWith('/')),
  /** Name of the protected secret that holds this provider's API key. */
  keyRef: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
})

const aliasSchema = v.object({
  /** Key of one entry in `providers`. R2A maps each alias to exactly one provider, without a fallback chain. */
  provider: v.string(),
  /** Model name that the provider receives in place of the alias. */
  model: v.pipe(v.string(), v.minLength(1)),
})

const configSchema = v.pipe(
  v.object({
    host: v.optional(v.literal(LOOPBACK_HOST), LOOPBACK_HOST),
    /** Port 0 selects a free port. Tests use it. */
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)), 11980),
    /**
     * Exact browser origins that can call the gateway. A request that sends any other `Origin` header is rejected.
     * Requests without an `Origin` header come from non-browser clients and only need the bearer token.
     */
    allowedOrigins: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
    /** Largest accepted request body. Inline base64 images make chat requests large. */
    maxRequestBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024)), 32 * 1024 * 1024),
    providers: v.record(v.string(), providerSchema),
    aliases: v.record(v.string(), aliasSchema),
  }),
  v.check(
    config => Object.values(config.aliases).every(alias => alias.provider in config.providers),
    'Every alias must name a configured provider.',
  ),
)

export type CompanionConfig = InferOutput<typeof configSchema>
export type ProviderConfig = CompanionConfig['providers'][string]

/**
 * Validates a raw configuration object.
 *
 * Throws when the host is not loopback, an alias names an unknown provider, or a field is malformed.
 */
export function parseConfig(input: unknown): CompanionConfig {
  const result = v.safeParse(configSchema, input)
  if (!result.success)
    throw new Error(`Invalid companion-core configuration: ${v.summarize(result.issues)}`)
  return result.output
}

/** Directory for the configuration file and protected secrets. `COMPANION_CORE_HOME` overrides it. */
export function resolveHome(): string {
  return process.env.COMPANION_CORE_HOME ?? join(process.env.LOCALAPPDATA ?? homedir(), 'AIRI-Companion')
}

export function configPath(home = resolveHome()): string {
  return join(home, 'companion-core.json')
}

export async function loadConfig(path = configPath()): Promise<CompanionConfig> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')))
}

/** Writes a starter file that has no providers. Existing files are kept. Returns `true` when a file was created. */
export async function writeStarterConfig(path = configPath()): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const starter = { port: 11980, allowedOrigins: [], providers: {}, aliases: {} }
  try {
    await writeFile(path, `${JSON.stringify(starter, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return false
    throw error
  }
}

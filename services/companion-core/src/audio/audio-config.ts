import type { InferInput, InferOutput } from 'valibot'

import type { SecretStore } from '../auth/secret-store'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as v from 'valibot'

import { resolveHome } from '../config/config'

const localSchema = v.strictObject({
  baseURL: v.pipe(v.string(), v.url(), v.check(isLoopbackTarget, 'The local audio target must use a literal loopback address.')),
  model: v.pipe(v.string(), v.regex(/^[\w.:-]{1,128}$/)),
  keyRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/))),
})

const cloudSchema = v.strictObject({
  keyRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)), 'provider-groq'),
  models: v.optional(v.pipe(v.array(v.picklist(['whisper-large-v3-turbo', 'whisper-large-v3'])), v.minLength(1), v.maxLength(2)), ['whisper-large-v3-turbo', 'whisper-large-v3']),
})

const audioSchema = v.pipe(v.strictObject({
  profile: v.picklist(['LOCAL', 'CLOUD', 'HYBRID', 'cloud-mura']),
  cloud: v.optional(cloudSchema, {}),
  local: v.optional(localSchema),
  /** The request limit includes multipart headers. @default 26214400 */
  maxRequestBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(25 * 1024 * 1024)), 25 * 1024 * 1024),
  /** The provider response stays in memory until it is complete. @default 1048576 */
  maxResponseBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(4 * 1024 * 1024)), 1024 * 1024),
  /** One deadline covers upload, fallback requests, and the provider response. @default 15000 */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(20), v.maxValue(120_000)), 15_000),
}), v.check(config => config.profile !== 'LOCAL' || config.local !== undefined, 'LOCAL requires an explicit audio target.'), v.check(config => !['CLOUD', 'cloud-mura'].includes(config.profile) || config.local === undefined, 'Cloud profiles cannot contain a local audio target.'))

/** Audio routing is independent of the chat aliases and provider configuration. */
export type AudioConfig = InferOutput<typeof audioSchema>
export type AudioConfigInput = InferInput<typeof audioSchema>

/** Rejects untrusted targets and malformed profile configuration before the gateway listens. */
export function parseAudioConfig(input: unknown): AudioConfig {
  const result = v.safeParse(audioSchema, input)
  if (!result.success)
    throw new Error('Invalid companion audio configuration.')
  return result.output
}

export function audioConfigPath(home = resolveHome()): string {
  return join(home, 'companion-audio.json')
}

/** An absent audio file leaves STT disabled. An invalid file stops startup. */
export async function loadAudioConfig(path = audioConfigPath()): Promise<AudioConfig | undefined> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw new Error('Cannot read companion audio configuration.')
  }
  try {
    return parseAudioConfig(JSON.parse(source))
  }
  catch {
    throw new Error('Invalid companion audio configuration.')
  }
}

/** Protected storage takes precedence over the inherited environment and the Windows user environment. Keys never reach process arguments. */
export async function loadGroqKey(store: SecretStore, keyRef: string): Promise<string | undefined> {
  const protectedKey = (await store.read(keyRef))?.trim()
  if (protectedKey)
    return protectedKey
  const inheritedKey = process.env.GROQ_API_KEY?.trim()
  if (inheritedKey)
    return inheritedKey
  if (process.platform !== 'win32')
    return undefined
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([Environment]::GetEnvironmentVariable("GROQ_API_KEY", "User"))'], { windowsHide: true })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 8192)
        child.kill()
    })
    child.stderr.resume()
    child.on('error', () => reject(new Error('Cannot read the Windows user Groq key.')))
    child.on('close', code => code === 0 ? resolve(output.trim() || undefined) : reject(new Error('Cannot read the Windows user Groq key.')))
  })
}

function isLoopbackTarget(value: string): boolean {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.endsWith('/')
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { audioConfigPath, loadAudioConfig, loadGroqKey, parseAudioConfig } from '../src/audio/audio-config'
import { MemorySecretStore } from '../src/auth/secret-store'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('audio configuration', () => {
  it('sets the Groq model order without changing chat configuration', () => {
    const config = parseAudioConfig({ profile: 'CLOUD' })

    expect(config.cloud.models).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(config.cloud.keyRef).toBe('provider-groq')
    expect(config.local).toBeUndefined()
  })

  it.each([
    { profile: 'LOCAL' },
    { profile: 'unknown' },
    { profile: 'CLOUD', local: { baseURL: 'http://127.0.0.1:11996/v1/', model: 'local' } },
    { profile: 'cloud-mura', local: { baseURL: 'http://127.0.0.1:11996/v1/', model: 'local' } },
    { profile: 'CLOUD', cloud: { baseURL: 'https://attacker.example/' } },
    { profile: 'CLOUD', cloud: { models: ['client-chosen-model'] } },
    { profile: 'CLOUD', cloud: { models: [] } },
    { profile: 'CLOUD', timeoutMs: 0 },
    { profile: 'CLOUD', maxRequestBytes: 100 * 1024 * 1024 },
    { profile: 'CLOUD', apiKey: 'plaintext-key' },
  ])('rejects invalid configuration %j', (config) => {
    expect(() => parseAudioConfig(config)).toThrow('Invalid companion audio configuration.')
  })

  it.each(['http://192.168.1.1/v1/', 'http://169.254.169.254/v1/', 'http://localhost/v1/', 'https://attacker.example/v1/', 'file:///tmp/', 'http://127.0.0.1/v1/?url=http://evil', 'http://user:password@127.0.0.1/v1/', 'http://127.0.0.1/v1/#fragment'])('rejects an untrusted local target %s', (baseURL) => {
    expect(() => parseAudioConfig({ profile: 'LOCAL', local: { baseURL, model: 'local' } })).toThrow('Invalid companion audio configuration.')
  })

  it('loads only the separate audio file and treats an absent file as disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'companion-audio-config-'))
    directories.push(home)
    const path = audioConfigPath(home)

    expect(await loadAudioConfig(path)).toBeUndefined()
    await writeFile(path, JSON.stringify({ profile: 'LOCAL', local: { baseURL: 'http://127.0.0.1:11996/v1/', model: 'local' } }))
    expect((await loadAudioConfig(path))?.profile).toBe('LOCAL')
    await writeFile(path, '{ invalid json secret-data')
    await expect(loadAudioConfig(path)).rejects.toThrow('Invalid companion audio configuration.')
  })

  it('loads the protected Groq key before the inherited user environment', async () => {
    vi.stubEnv('GROQ_API_KEY', 'environment-key')
    const store = new MemorySecretStore()
    await store.write('provider-groq', 'protected-key')

    expect(await loadGroqKey(store, 'provider-groq')).toBe('protected-key')
  })

  it('loads GROQ_API_KEY when the protected Groq key is absent', async () => {
    vi.stubEnv('GROQ_API_KEY', ' environment-key ')

    expect(await loadGroqKey(new MemorySecretStore(), 'provider-groq')).toBe('environment-key')
  })
})

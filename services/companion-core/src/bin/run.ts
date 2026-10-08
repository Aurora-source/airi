#!/usr/bin/env node
import process from 'node:process'

import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { INFERENCE_TOKEN_SECRET, loadOrCreateCredentials } from '../auth/credentials'
import { DpapiSecretStore } from '../auth/secret-store'
import { CompanionRuntime } from '../companion/runtime'
import { configPath, loadConfig, LOOPBACK_HOST, resolveHome, writeStarterConfig } from '../config/config'
import { startCompanionMcpServer } from '../mcp/server'
import { runProbes } from '../probe/run-probes'
import { ProbeStore } from '../probe/store'
import { startGateway } from '../server'
import { openDatabase } from '../store/database'

const USAGE = `Usage: companion-core <command>

Commands:
  init                                    Create the starter configuration and the gateway tokens.
  serve                                   Start the gateway on 127.0.0.1.
  secret-import <name> --from-env <VAR>   Store the value of environment variable VAR as protected secret <name>.
  probe [model ...] [--deep]              Test each model of the alias chains and store what it supports.
                                          --deep also finds the largest prompt that each model accepts. It costs quota.
  token                                   Print the inference token. Paste it into the AIRI provider API key field.
  mcp                                     Run the memory and look_now tools as a stdio MCP server. AIRI starts it from mcp.json.`

/**
 * Command line entry point for the Companion Gateway.
 *
 * Call stack:
 *
 * main
 *   -> {@link loadConfig} / {@link loadOrCreateCredentials}
 *     -> {@link startGateway} (../server)
 */
async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'from-env': { type: 'string' }, 'deep': { type: 'boolean' } },
  })
  const [command, name, ...more] = positionals
  const home = resolveHome()
  const store = new DpapiSecretStore(join(home, 'secrets'))

  switch (command) {
    case 'init': {
      const created = await writeStarterConfig()
      await loadOrCreateCredentials(store)
      console.info(`${created ? 'Created' : 'Kept'} ${configPath()}`)
      console.info(`Gateway tokens are stored in ${join(home, 'secrets')}`)
      return
    }
    case 'serve': {
      const config = await loadConfig()
      const credentials = await loadOrCreateCredentials(store)
      const providerKeys = new Map<string, string>()
      for (const [providerName, provider] of Object.entries(config.providers)) {
        // A local provider can run without a key.
        if (!provider.keyRef)
          continue
        const key = await store.read(provider.keyRef)
        if (key)
          providerKeys.set(provider.keyRef, key)
        else
          console.warn(`No API key stored for provider "${providerName}" (secret "${provider.keyRef}"). Its requests get 503.`)
      }
      const channelToken = config.channel.tokenRef ? await store.read(config.channel.tokenRef) : undefined
      // Background failures name the operation and a reason. They never carry memory or screen text.
      const report = (message: string) => process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), companion: message })}\n`)
      const companion = await CompanionRuntime.open({ config, home, channelToken, report })
      const gateway = await startGateway({ config, credentials, providerKeys, companion, backupDirectory: join(home, 'memory', 'backups') })
      // Vision routes through the gateway's router, so perception starts only once the gateway exists.
      companion.attach(gateway.runtime)
      const perception = !companion.perception ? 'off' : config.perception.ambient ? 'ambient' : 'look_now only'
      console.info(`Companion Gateway listening at ${gateway.baseURL} (aliases: ${Object.keys(config.aliases).join(', ') || 'none'}, memory: ${companion.memory ? 'on' : 'off'}, perception: ${perception})`)
      // Perception stops first, so no capture or upload outlives the router. Memory closes last, after the final turn.
      const stop = () => {
        void Promise.resolve(companion.perception?.shutdown())
          .then(() => gateway.close())
          .then(() => companion.close())
          .finally(() => process.exit(0))
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      return
    }
    case 'probe': {
      const config = await loadConfig()
      const providerKeys = new Map<string, string>()
      for (const provider of Object.values(config.providers)) {
        const key = provider.keyRef ? await store.read(provider.keyRef) : undefined
        if (provider.keyRef && key)
          providerKeys.set(provider.keyRef, key)
      }
      const db = openDatabase(config.store.path ?? join(home, 'companion-core.sqlite'))
      const modelIds = [name, ...more].filter((id): id is string => Boolean(id))
      let failed = 0
      const results = await runProbes(config, providerKeys, new ProbeStore(db, Date.now), {
        modelIds: modelIds.length > 0 ? modelIds : undefined,
        gapMs: 2000,
        deepStepsTokens: values.deep ? [2000, 8000, 16_000, 32_000, 64_000, 128_000] : undefined,
        onResult: (result) => {
          failed += result.working ? 0 : 1
          // One line per model. It holds capabilities and numbers, and no message text or key.
          console.info(`${result.modelId.padEnd(24)} ${result.working ? 'working' : 'NOT WORKING'}  exists=${result.exists ?? '?'} stream=${result.streaming} tools=${result.tools}${result.toolCallIndexMissing ? '(no index)' : ''} images=${result.images} structured=${result.structuredOutput} firstByte=${result.firstByteMs ?? '?'}ms${result.maxAcceptedPromptTokens ? ` maxPrompt=${result.maxAcceptedPromptTokens}` : ''}`)
          for (const [test, reason] of Object.entries(result.failures))
            console.info(`    ${test}: ${reason}`)
        },
      })
      db.close()
      if (results.length === 0)
        console.info('No model to probe. The profile can exclude local models.')
      if (failed > 0)
        process.exitCode = 1
      return
    }
    case 'secret-import': {
      const variable = values['from-env']
      if (!name || !variable)
        throw new Error('secret-import needs a secret name and --from-env <VAR>.')
      const value = process.env[variable]?.trim()
      if (!value)
        throw new Error(`Environment variable ${variable} is empty or not set.`)
      await store.write(name, value)
      // Report only the length, so the value never reaches a terminal or a log.
      console.info(`Stored secret "${name}" (${value.length} characters).`)
      return
    }
    case 'token': {
      const token = await store.read(INFERENCE_TOKEN_SECRET)
      if (!token)
        throw new Error('No inference token exists. Run "companion-core init" first.')
      process.stdout.write(`${token}\n`)
      return
    }
    case 'mcp': {
      // stdout carries the MCP protocol here, so this command prints nothing else to it.
      const config = await loadConfig()
      const token = await store.read(INFERENCE_TOKEN_SECRET)
      if (!token)
        throw new Error('No inference token exists. Run "companion-core init" first.')
      await startCompanionMcpServer({ baseURL: `http://${LOOPBACK_HOST}:${config.port}/v1/`, token })
      return
    }
    default:
      console.info(USAGE)
      process.exitCode = command ? 1 : 0
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'companion-core failed.')
  process.exitCode = 1
})

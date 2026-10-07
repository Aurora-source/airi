#!/usr/bin/env node
import process from 'node:process'

import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { INFERENCE_TOKEN_SECRET, loadOrCreateCredentials } from '../auth/credentials'
import { DpapiSecretStore } from '../auth/secret-store'
import { configPath, loadConfig, resolveHome, writeStarterConfig } from '../config/config'
import { startGateway } from '../server'

const USAGE = `Usage: companion-core <command>

Commands:
  init                                    Create the starter configuration and the gateway tokens.
  serve                                   Start the gateway on 127.0.0.1.
  secret-import <name> --from-env <VAR>   Store the value of environment variable VAR as protected secret <name>.
  token                                   Print the inference token. Paste it into the AIRI provider API key field.`

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
    options: { 'from-env': { type: 'string' } },
  })
  const [command, name] = positionals
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
      const gateway = await startGateway({ config, credentials, providerKeys })
      console.info(`Companion Gateway listening at ${gateway.baseURL} (aliases: ${Object.keys(config.aliases).join(', ') || 'none'})`)
      const stop = () => {
        void gateway.close().finally(() => process.exit(0))
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
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
    default:
      console.info(USAGE)
      process.exitCode = command ? 1 : 0
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'companion-core failed.')
  process.exitCode = 1
})

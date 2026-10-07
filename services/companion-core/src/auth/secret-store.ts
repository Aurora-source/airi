import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Persistent storage for gateway tokens and provider API keys. */
export interface SecretStore {
  /** Returns `undefined` when the secret was never written. */
  read: (name: string) => Promise<string | undefined>
  write: (name: string, value: string) => Promise<void>
}

const SECRET_NAME = /^[a-z0-9-]+$/

/**
 * Stores each secret as a Windows DPAPI blob in `<directory>/<name>.dpapi`.
 *
 * DPAPI ties a blob to the current Windows user, so other users and other machines cannot decrypt it.
 * Values travel to PowerShell on stdin as base64. They never appear in process arguments or logs.
 */
export class DpapiSecretStore implements SecretStore {
  constructor(private readonly directory: string) {
    if (process.platform !== 'win32')
      throw new Error('DpapiSecretStore requires Windows.')
  }

  async read(name: string): Promise<string | undefined> {
    let blob: string
    try {
      blob = (await readFile(this.pathOf(name), 'utf8')).trim()
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined
      throw error
    }
    const plain = await runDpapi('Unprotect', blob)
    return Buffer.from(plain, 'base64').toString('utf8')
  }

  async write(name: string, value: string): Promise<void> {
    const blob = await runDpapi('Protect', Buffer.from(value, 'utf8').toString('base64'))
    await mkdir(this.directory, { recursive: true })
    // Write to a temporary file first, so a crash never leaves a truncated blob.
    const target = this.pathOf(name)
    await writeFile(`${target}.tmp`, blob, 'utf8')
    await rename(`${target}.tmp`, target)
  }

  private pathOf(name: string): string {
    if (!SECRET_NAME.test(name))
      throw new Error(`Invalid secret name: ${name}`)
    return join(this.directory, `${name}.dpapi`)
  }
}

/** Keeps secrets in process memory. Tests use it. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async read(name: string): Promise<string | undefined> {
    return this.values.get(name)
  }

  async write(name: string, value: string): Promise<void> {
    this.values.set(name, value)
  }
}

/** Runs one fixed DPAPI operation. Input and output are base64 so that no text encoding can change the bytes. */
function runDpapi(operation: 'Protect' | 'Unprotect', base64Input: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')
  // NOTICE:
  // Node has no DPAPI binding. Windows PowerShell 5.1 ships with Windows and exposes ProtectedData.
  // The absolute System32 path stops a planted powershell.exe on PATH from running.
  // Removal condition: the workspace adds a maintained DPAPI binding.
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8').trim())
        return
      }
      // stderr holds PowerShell diagnostics only. The secret is never echoed by the script.
      reject(new Error(`DPAPI ${operation} failed with exit code ${code}: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 300)}`))
    })
    child.stdin.end(base64Input)
  })
}

import process from 'node:process'

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * Local addresses that one TCP port listens on, from Windows `Get-NetTCPConnection`. It reads this machine's own
 * socket table and sends nothing on the network. Other platforms return no addresses.
 */
export function listeningAddresses(port: number): Promise<readonly string[]> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    return Promise.resolve([])
  // NOTICE:
  // Node has no API for the listening sockets of another process. Windows PowerShell 5.1 ships with Windows.
  // The absolute System32 path stops a planted powershell.exe on PATH from running, as in the DPAPI secret store.
  // Removal condition: the workspace adds a maintained socket-table binding.
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }`
  return new Promise((resolve) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(output.split(/\r?\n/).map(line => line.trim()).filter(line => /^[\d.:a-f]+$/i.test(line))))
  })
}

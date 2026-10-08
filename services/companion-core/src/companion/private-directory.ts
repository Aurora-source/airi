import process from 'node:process'

import { spawn } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Creates a directory that only the current operating-system user can open. Memory and screen data stay private.
 * On Windows it removes inherited entries and grants full control to the current user alone.
 */
export async function createPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700)
    return
  }
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!user)
    throw new Error('Cannot restrict the memory directory: the Windows user name is unknown.')
  // NOTICE:
  // Node has no Windows ACL API. icacls ships with Windows.
  // The absolute System32 path stops a planted icacls.exe on PATH from running.
  // Removal condition: the workspace adds a maintained Windows ACL binding.
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [directory, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`icacls failed with exit code ${code}`)))
  })
}

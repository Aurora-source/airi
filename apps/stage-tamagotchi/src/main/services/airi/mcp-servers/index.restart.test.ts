import process from 'node:process'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(() => '0.0.0-test'),
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: { showItemInFolder: vi.fn() },
}))

vi.mock('@guiiai/logg', () => {
  const sink: Record<string, unknown> = {}
  const logger = new Proxy(sink, { get: (_target, name) => name === 'then' ? undefined : () => logger })
  return { useLogg: () => ({ useGlobalConfig: () => logger }) }
})

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

const fixturePath = fileURLToPath(new URL('./restart-fixture-server.mjs', import.meta.url))

let directory: string
let logPath: string

function readLog() {
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
}

function startedPids() {
  return readLog().filter(line => line.startsWith('start ')).map(line => Number(line.slice(6)))
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function alivePids() {
  return startedPids().filter(isAlive)
}

/** Waits for a process that is closing to leave. The SDK ends the input, waits up to two seconds, and then kills. */
async function settle() {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && alivePids().length > 1)
    await new Promise(resolve => setTimeout(resolve, 100))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'airi-mcp-restart-'))
  logPath = join(directory, 'fixture.log')
  writeFileSync(logPath, '')
  appMock.getPath.mockReturnValue(directory)
  writeFileSync(join(directory, 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [fixturePath], env: { MCP_FIXTURE_LOG: logPath } } },
  }))
})

afterEach(() => {
  // A failing test must not leave server processes behind.
  for (const pid of alivePids()) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {
      // The process left on its own.
    }
  }
  rmSync(directory, { recursive: true, force: true })
})

describe('mcp stdio manager restart', () => {
  it('keeps exactly one server process after repeated restarts', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    await manager.applyAndRestart()
    await manager.applyAndRestart()
    await manager.applyAndRestart()
    await settle()

    expect(startedPids()).toHaveLength(3)
    expect(alivePids()).toHaveLength(1)
    await manager.stopAll()
  }, 30_000)

  // ROOT CAUSE:
  //
  // Overlapping restarts each call `sessions.set(name, ...)`, which replaces the earlier session without closing it.
  // The replaced process loses its handle and keeps running.
  //
  // We fixed this by running lifecycle changes in order, and by closing a session that `startServer` replaces.
  it('keeps exactly one server process when restarts overlap', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    // The startup restart, the settings page, and the desktop overlay can all ask for a restart at about the same time.
    await Promise.all([manager.applyAndRestart(), manager.applyAndRestart(), manager.applyAndRestart()])
    await settle()

    expect(alivePids()).toHaveLength(1)
    await manager.stopAll()
  }, 30_000)

  it('runs a tool exactly once after overlapping restarts', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    await Promise.all([manager.applyAndRestart(), manager.applyAndRestart(), manager.applyAndRestart()])
    await settle()

    await manager.callTool({ name: 'fixture::ping' })

    expect(readLog().filter(line => line.startsWith('call '))).toHaveLength(1)
    await manager.stopAll()
  }, 30_000)

  it('stops every server process on stopAll', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    await manager.applyAndRestart()

    await manager.stopAll()
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(alivePids()).toHaveLength(0)
  }, 30_000)
})

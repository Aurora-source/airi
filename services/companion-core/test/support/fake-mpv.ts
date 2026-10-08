import type { Server, Socket } from 'node:net'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

/**
 * Plays mpv's JSON IPC server on a real Windows named pipe: property observation, `get_property`, and events.
 * It answers only the commands that mpv answers and records every command, so tests can check what the Core sent.
 *
 * @example
 * const mpv = new FakeMpv({ 'media-title': 'Frieren - 13.mkv' })
 * await mpv.listen()
 * mpv.event('file-loaded')
 */
export class FakeMpv {
  readonly pipe = `airi-test-${randomUUID().slice(0, 8)}`
  readonly commands: unknown[][] = []
  private server?: Server
  private readonly sockets = new Set<Socket>()
  private readonly observers = new Map<string, number[]>()

  constructor(readonly properties: Record<string, unknown> = {}) {}

  get path(): string {
    return `\\\\.\\pipe\\${this.pipe}`
  }

  get clients(): number {
    return this.sockets.size
  }

  async listen(): Promise<void> {
    this.server = createServer(socket => this.accept(socket))
    await new Promise<void>(resolve => this.server!.listen(this.path, resolve))
  }

  /** Changes a property and notifies observers, like mpv does. */
  set(name: string, value: unknown): void {
    this.properties[name] = value
    for (const id of this.observers.get(name) ?? [])
      this.broadcast({ event: 'property-change', id, name, data: value ?? null })
  }

  event(name: string, extra: Record<string, unknown> = {}): void {
    this.broadcast({ event: name, ...extra })
  }

  /** Writes raw bytes to every client, for example a broken line. */
  raw(bytes: Buffer | string): void {
    for (const socket of this.sockets)
      socket.write(bytes)
  }

  /** The player crashed: every client connection breaks. The pipe stays. */
  dropClients(): void {
    for (const socket of this.sockets)
      socket.destroy()
    this.sockets.clear()
  }

  async close(): Promise<void> {
    this.dropClients()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
    this.server = undefined
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        this.answer(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
  }

  private answer(socket: Socket, line: string): void {
    const message = JSON.parse(line) as { command: unknown[], request_id?: number }
    this.commands.push(message.command)
    const [name, ...args] = message.command
    const reply = (fields: Record<string, unknown>) => socket.write(`${JSON.stringify({ request_id: message.request_id ?? 0, ...fields })}\n`)
    if (name === 'observe_property') {
      const [id, property] = args as [number, string]
      this.observers.set(property, [...(this.observers.get(property) ?? []), id])
      reply({ error: 'success' })
      socket.write(`${JSON.stringify({ event: 'property-change', id, name: property, data: this.properties[property] ?? null })}\n`)
      return
    }
    if (name === 'get_property') {
      const property = args[0] as string
      if (this.properties[property] === undefined)
        reply({ error: 'property unavailable' })
      else
        reply({ error: 'success', data: this.properties[property] })
      return
    }
    reply({ error: 'invalid parameter' })
  }

  private broadcast(message: Record<string, unknown>): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    for (const socket of this.sockets)
      socket.write(line)
  }
}

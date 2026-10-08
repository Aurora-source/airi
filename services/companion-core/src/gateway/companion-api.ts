import type { IncomingMessage, ServerResponse } from 'node:http'

import type { CompanionMemory } from '../companion/memory'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import * as v from 'valibot'

import { readRequestBody, RequestBodyTooLargeError, sendError } from './http'

/** Admin and tool bodies are small JSON objects. */
const MAX_BODY_BYTES = 64 * 1024

const itemId = v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/))
const characterId = v.pipe(v.string(), v.regex(/^[\w.:-]{1,256}$/))
const shortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000))
const category = v.picklist(['identity', 'preference', 'interest', 'goal', 'stable_fact', 'personality', 'guideline', 'relationship', 'nickname', 'inside_joke', 'promise', 'open_thread', 'watch_session', 'experience'])

export const toolSchemas = {
  memory_recall: v.strictObject({ query: shortText }),
  memory_remember: v.strictObject({
    text: shortText,
    key: v.pipe(v.string(), v.trim(), v.regex(/^[\w.-]{1,128}$/)),
    value: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512)),
    category,
    scope: v.picklist(['global', 'character']),
    correction: v.optional(v.boolean()),
    cardinality: v.optional(v.picklist(['single', 'set'])),
  }),
  memory_forget: v.strictObject({ itemId }),
}

export type ToolName = keyof typeof toolSchemas

export interface CompanionApiContext {
  memory?: CompanionMemory
  /** Folder for memory backups. Each backup gets a new file. */
  backupDirectory?: string
}

type Reply = (status: number, body: unknown) => void

/**
 * Serves `/ops/memory/*`. The caller has already checked the ops token. Returns `false` for an unknown path.
 * Every action works on the one configured user. Edit, delete, and forget take any item id, because Ops is the user.
 */
export async function handleOpsMemory(req: IncomingMessage, res: ServerResponse, path: string, context: CompanionApiContext): Promise<boolean> {
  const reply = jsonReply(res)
  const method = req.method ?? ''
  const { memory } = context
  if (!path.startsWith('/ops/memory/'))
    return false
  if (method === 'GET' && path === '/ops/memory/status') {
    reply(200, memory ? { enabled: true, ...memory.status() } : { enabled: false })
    return true
  }
  if (!memory) {
    sendError(res, 503, 'server_error', 'memory_disabled', 'Memory is not enabled.')
    return true
  }
  const userId = memory.userId
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (method === 'GET' && path === '/ops/memory/items') {
    const character = v.safeParse(characterId, url.searchParams.get('characterId'))
    if (!character.success)
      return badRequest(res, 'characterId is required.')
    const kind = url.searchParams.get('kind')
    const items = await memory.ports.inspect({
      userId,
      characterId: character.output,
      kind: kind === 'fact' || kind === 'episode' || kind === 'relationship' ? kind : undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
    })
    reply(200, { items })
    return true
  }
  if (method === 'GET' && path === '/ops/memory/export') {
    reply(200, await memory.ports.exportUser(userId))
    return true
  }
  if (method !== 'POST')
    return false

  const body = await readJson(req, res)
  if (body === undefined)
    return true
  switch (path) {
    case '/ops/memory/search': {
      const parsed = v.safeParse(v.strictObject({ characterId, query: shortText }), body)
      if (!parsed.success)
        return badRequest(res, 'search needs characterId and query.')
      const result = await memory.ports.recall({ userId, characterId: parsed.output.characterId, query: parsed.output.query, deadlineMs: 1000 })
      reply(200, { items: result.items, promptBytes: Buffer.byteLength(result.prompt), timedOut: result.timedOut })
      return true
    }
    case '/ops/memory/items/edit': {
      const parsed = v.safeParse(v.strictObject({
        itemId,
        text: v.optional(shortText),
        value: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
        confidence: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
        pinned: v.optional(v.boolean()),
        resolveConflict: v.optional(v.boolean()),
      }), body)
      if (!parsed.success)
        return badRequest(res, 'edit needs itemId and valid fields.')
      const item = await memory.ports.edit({ userId, ...parsed.output })
      reply(item ? 200 : 404, item ? { item } : { error: { code: 'not_found', message: 'No such item.' } })
      return true
    }
    case '/ops/memory/items/delete':
    case '/ops/memory/items/forget': {
      const parsed = v.safeParse(v.strictObject({ itemId }), body)
      if (!parsed.success)
        return badRequest(res, 'itemId is required.')
      const done = path.endsWith('/forget')
        ? await memory.ports.forget({ userId, itemId: parsed.output.itemId })
        : await memory.ports.delete({ userId, itemId: parsed.output.itemId })
      reply(done ? 200 : 404, { ok: done })
      return true
    }
    case '/ops/memory/private': {
      const parsed = v.safeParse(v.strictObject({ enabled: v.boolean() }), body)
      if (!parsed.success)
        return badRequest(res, 'enabled must be a boolean.')
      await memory.ports.setPrivateMode(userId, parsed.output.enabled)
      reply(200, { ok: true, privateMode: parsed.output.enabled })
      return true
    }
    case '/ops/memory/consolidate': {
      reply(200, { result: await memory.consolidateNow() ?? null })
      return true
    }
    case '/ops/memory/backup': {
      if (!context.backupDirectory) {
        sendError(res, 503, 'server_error', 'backup_unavailable', 'No backup folder is configured.')
        return true
      }
      await mkdir(context.backupDirectory, { recursive: true })
      const file = `memory-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`
      await memory.ports.backup(join(context.backupDirectory, file))
      reply(200, { ok: true, file })
      return true
    }
    default:
      return false
  }
}

/**
 * Serves `POST /v1/companion/tools/<name>` for the MCP server. The caller has already checked the inference token.
 * Tools act for the configured user and the character of the newest AIRI turn. No argument can name another user.
 */
export async function handleCompanionTool(req: IncomingMessage, res: ServerResponse, name: string, context: CompanionApiContext): Promise<void> {
  const reply = jsonReply(res)
  const { memory } = context
  if (!(name in toolSchemas)) {
    sendError(res, 404, 'invalid_request_error', 'unknown_tool', 'Unknown companion tool.')
    return
  }
  if (!memory) {
    sendError(res, 503, 'server_error', 'memory_disabled', 'Memory is not enabled.')
    return
  }
  const body = await readJson(req, res)
  if (body === undefined)
    return
  const tool = name as ToolName
  const parsed = v.safeParse(toolSchemas[tool], body)
  if (!parsed.success) {
    badRequest(res, `Invalid arguments: ${v.summarize(parsed.issues)}`)
    return
  }
  switch (tool) {
    case 'memory_recall': {
      const result = await memory.recallForTool((parsed.output as v.InferOutput<typeof toolSchemas.memory_recall>).query)
      reply('error' in result ? 409 : 200, result)
      return
    }
    case 'memory_remember': {
      const result = await memory.rememberForTool(parsed.output as v.InferOutput<typeof toolSchemas.memory_remember>)
      reply(result.status === 'no-active-character' ? 409 : 200, result)
      return
    }
    case 'memory_forget': {
      const result = await memory.forgetForTool((parsed.output as v.InferOutput<typeof toolSchemas.memory_forget>).itemId)
      reply(result.status === 'forgotten' ? 200 : result.status === 'not-found' ? 404 : 409, result)
    }
  }
}

function jsonReply(res: ServerResponse): Reply {
  return (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
}

function badRequest(res: ServerResponse, message: string): true {
  sendError(res, 400, 'invalid_request_error', 'invalid_arguments', message)
  return true
}

/** Reads a small JSON object. Sends the error itself and returns `undefined` when the body is unusable. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    const raw = await readRequestBody(req, MAX_BODY_BYTES)
    return raw.byteLength === 0 ? {} : JSON.parse(raw.toString('utf8'))
  }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      sendError(res, 413, 'invalid_request_error', 'request_too_large', 'Request body is too large.')
    else
      sendError(res, 400, 'invalid_request_error', 'invalid_json', 'Request body must be JSON.')
    return undefined
  }
}

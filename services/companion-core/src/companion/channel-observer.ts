import type { ToolEvidence } from '../memory/ports'
import type { CompanionMemory, PersistedTurn } from './memory'

import { errorMessageFrom } from '@moeru/std'
import { Client } from '@proj-airi/server-sdk'

import * as v from 'valibot'

const id = v.pipe(v.string(), v.regex(/^[\w.:-]{1,256}$/))

const turnSchema = v.object({
  sessionId: id,
  turnId: id,
  assistantTurnId: v.optional(id),
  characterId: v.optional(id),
})

const partSchema = v.object({ type: v.optional(v.string()), text: v.optional(v.string()) })
const contentSchema = v.optional(v.union([v.string(), v.array(v.looseObject(partSchema.entries))]))

const sliceSchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
  id: v.optional(v.string()),
  isError: v.optional(v.boolean()),
  result: v.optional(v.unknown()),
  toolCall: v.optional(v.looseObject({ toolCallId: v.optional(v.string()), toolName: v.optional(v.string()) })),
})

const completeSchema = v.looseObject({
  'turn': v.optional(turnSchema),
  'message': v.optional(v.looseObject({
    id: v.optional(v.string()),
    content: contentSchema,
    categorization: v.optional(v.looseObject({ speech: v.optional(v.string()) })),
    slices: v.optional(v.array(v.looseObject(sliceSchema.entries))),
    generationTranscript: v.optional(v.looseObject({ id: v.optional(v.string()) })),
  })),
  'gen-ai:chat': v.optional(v.looseObject({
    message: v.optional(v.looseObject({ id: v.optional(v.string()), content: contentSchema })),
    input: v.optional(v.looseObject({ type: v.optional(v.string()), data: v.optional(v.looseObject({ id: v.optional(v.string()) })) })),
  })),
})

function contentText(content: string | { type?: string, text?: string }[] | undefined): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  return content.map(part => part.type === 'text' || part.type === undefined ? part.text ?? '' : '').filter(Boolean).join(' ')
}

/**
 * Reads one `output:gen-ai:chat:complete` event into a persisted turn.
 * It returns `undefined` unless the event carries AIRI's turn identity with a character, so a turn without stable ids
 * never becomes authoritative memory.
 */
export function persistedTurnOf(data: unknown, now: number): PersistedTurn | undefined {
  const parsed = v.safeParse(completeSchema, data)
  if (!parsed.success)
    return undefined
  const event = parsed.output
  const turn = event.turn
  if (!turn?.characterId)
    return undefined
  const message = event.message
  const chat = event['gen-ai:chat']
  const sparkId = chat?.input?.type === 'spark:notify' ? chat.input.data?.id : undefined
  const assistantText = message?.categorization?.speech?.trim() || contentText(message?.content)
    || (message?.slices ?? []).filter(slice => slice.type === 'text').map(slice => slice.text ?? '').join('')
  const results = new Map((message?.slices ?? []).filter(slice => slice.type === 'tool-call-result' && slice.id).map(slice => [slice.id!, slice]))
  const tools: ToolEvidence[] = (message?.slices ?? []).flatMap((slice) => {
    const callId = slice.toolCall?.toolCallId
    const name = slice.toolCall?.toolName
    if (slice.type !== 'tool-call' || !callId || !name || !v.is(id, callId) || !v.is(id, name))
      return []
    const result = results.get(callId)
    const text = typeof result?.result === 'string' ? result.result : JSON.stringify(result?.result ?? '')
    return [{ callId, name, outcome: result?.isError ? 'failed' as const : 'success' as const, text: (text || '(no result)').slice(0, 400) }]
  })
  return {
    sessionId: turn.sessionId,
    characterId: turn.characterId,
    userMessageId: turn.turnId,
    userText: contentText(chat?.message?.content),
    assistantTurnId: turn.assistantTurnId ?? message?.generationTranscript?.id ?? message?.id ?? turn.turnId,
    assistantText,
    occurredAt: now,
    tools: tools.slice(0, 32),
    ...(sparkId && v.is(id, sparkId) ? { sparkId } : {}),
  }
}

export interface ChannelObserverOptions {
  url: string
  token?: string
  now?: () => number
  report?: (message: string) => void
  /** Tests replace the server channel client. */
  createClient?: (options: ConstructorParameters<typeof Client>[0]) => Pick<Client, 'onEvent' | 'close'>
}

/**
 * The authoritative memory observer. It joins AIRI's server channel as module `companion-core` and admits the turns that
 * AIRI reports after storage succeeded. Its connection state opens and closes R4 authority windows.
 */
export class ChannelObserver {
  private client?: Pick<Client, 'onEvent' | 'close'>
  private readonly now: () => number
  private readonly report: (message: string) => void

  constructor(private readonly memory: CompanionMemory, private readonly options: ChannelObserverOptions) {
    this.now = options.now ?? Date.now
    this.report = options.report ?? (() => {})
  }

  start(): void {
    if (this.client)
      return
    const create = this.options.createClient ?? (clientOptions => new Client(clientOptions))
    this.client = create({
      url: this.options.url,
      name: 'companion-core',
      token: this.options.token,
      possibleEvents: ['output:gen-ai:chat:complete'],
      autoConnect: true,
      autoReconnect: true,
      maxReconnectAttempts: Number.POSITIVE_INFINITY,
      onStateChange: ({ status }) => this.memory.setChannelConnected(status === 'ready'),
      onError: error => this.report(`server channel error: ${errorMessageFrom(error) ?? 'unknown'}`),
    })
    this.client.onEvent('output:gen-ai:chat:complete', (event) => {
      void this.handle(event.data)
    })
  }

  async handle(data: unknown): Promise<void> {
    const turn = persistedTurnOf(data, this.now())
    if (!turn)
      return
    await this.memory.observePersistedTurn(turn)
  }

  close(): void {
    this.memory.setChannelConnected(false)
    this.client?.close()
    this.client = undefined
  }
}

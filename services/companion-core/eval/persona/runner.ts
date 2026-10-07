import type { CheckResult, RunRecord } from './checks'
import type { Completion, GatewayClient } from './client'
import type { Scenario } from './scenarios'

import { runChecks } from './checks'

/** What the harness stores for one model answering one scene. */
export interface ResultRow {
  scenarioId: string
  modelId: string
  record: RunRecord
  checks: CheckResult[]
  finishReason?: string
  usage?: { promptTokens?: number, completionTokens?: number }
  /** The model that the gateway reports as the one that answered. For a pinned request it is the pinned model. */
  servedBy?: string
  waitedMs: number
}

/**
 * The tools of every scene: a weather tool, and the two MCP proxy tools that AIRI always sends.
 * AIRI sends nine tools of about 3.2k tokens. The routing tests cover that size. Here a small set is enough
 * to see whether a model calls a tool when it should, and leaves tools alone when it should not.
 */
export const EVAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Gets the current weather of a city.',
      parameters: { type: 'object', properties: { location: { type: 'string', description: 'The city name, for example Osaka.' } }, required: ['location'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'builtIn_mcpListTools',
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'builtIn_mcpCallTool',
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Tool name in "<serverName>::<toolName>" format' }, arguments: { type: 'string', description: 'JSON object of tool arguments' } }, required: ['name', 'arguments'], additionalProperties: false },
    },
  },
]

type Message = Record<string, unknown>

/** The messages of a scene as AIRI sends them: the system prompt, the history, the injected context as a user message, and the user. */
export function buildMessages(scenario: Scenario, systemPrompt: string): Message[] {
  return [
    { role: 'system', content: systemPrompt },
    ...scenario.history.map(turn => ({ role: turn.role, content: turn.content })),
    ...(scenario.context ? [{ role: 'user', content: scenario.context }] : []),
    { role: 'user', content: scenario.user },
  ]
}

/**
 * Runs one scene on one model. A tool scene takes two rounds: the model calls the tool, the harness answers with
 * the scene's mock result, and the model writes the final answer. The model is pinned, so the gateway never swaps it.
 */
export async function runScenario(client: GatewayClient, pin: string, modelId: string, scenario: Scenario, systemPrompt: string): Promise<ResultRow> {
  const messages = buildMessages(scenario, systemPrompt)
  const first = await client.complete(pin, { messages, tools: EVAL_TOOLS, tool_choice: 'auto' })

  let final: Completion = first
  let totalMs = first.totalMs
  let waitedMs = first.waitedMs
  const calls = first.toolCalls.filter(call => call.name)

  // A scene that offers a tool continues after the call. A model that calls a tool in another scene is judged on that call alone.
  if (scenario.tool && calls.length > 0 && first.status === 200) {
    const followUp: Message[] = [
      ...messages,
      {
        role: 'assistant',
        content: first.text || null,
        tool_calls: calls.map((call, index) => ({
          id: call.id ?? `call_${index}`,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
          ...(call.extra ? { extra_content: call.extra } : {}),
        })),
      },
      ...calls.map((call, index) => ({
        role: 'tool',
        tool_call_id: call.id ?? `call_${index}`,
        content: call.name === scenario.tool!.name ? scenario.tool!.result : `Tool ${call.name} is not available.`,
      })),
    ]
    final = await client.complete(pin, { messages: followUp, tools: EVAL_TOOLS, tool_choice: 'auto' })
    totalMs += final.totalMs
    waitedMs += final.waitedMs
  }

  const record: RunRecord = {
    scenarioId: scenario.id,
    modelId,
    text: final.text,
    toolCalls: calls.map(call => ({ name: call.name!, arguments: call.arguments })),
    reasoningChannel: first.reasoningChannel || final.reasoningChannel,
    status: final.status,
    firstByteMs: first.firstByteMs,
    totalMs: totalMs - waitedMs,
    error: final.error ?? first.error,
  }
  return {
    scenarioId: scenario.id,
    modelId,
    record,
    checks: runChecks(scenario, record, systemPrompt),
    finishReason: final.finishReason,
    usage: final.usage,
    servedBy: final.servedBy,
    waitedMs,
  }
}

export interface RunModelOptions {
  client: GatewayClient
  /** The alias whose chain holds the model, for example `companion-eval`. */
  alias: string
  modelId: string
  scenarios: Scenario[]
  systemPrompt: string
  /** Scenes that this model already answered. A resumed run skips them. */
  done?: ReadonlySet<string>
  onRow: (row: ResultRow) => void
}

/** Runs the scenes on one model, one after the other. A scene that fails is recorded with its error and the run goes on. */
export async function runModel(options: RunModelOptions): Promise<void> {
  const pin = `${options.alias}:${options.modelId}`
  for (const scenario of options.scenarios) {
    if (options.done?.has(`${scenario.id}|${options.modelId}`))
      continue
    options.onRow(await runScenario(options.client, pin, options.modelId, scenario, options.systemPrompt))
  }
}

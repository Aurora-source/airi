import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GatewayRuntime } from './runtime'

import * as v from 'valibot'

import { spendingPatchSchema } from '../paid/paid-gemini'
import { badRequest, jsonReply, readJson } from './companion-api'

/**
 * Serves `/ops/models/*`, `/ops/usage/*`, and `/ops/cloud`. The caller has already checked the ops token, so these are
 * authenticated user actions. Returns `false` for an unknown path.
 *
 * - `GET /ops/models`: selectable Gemini models, efforts, prices, discovery, and the current selection.
 * - `POST /ops/models/select` `{ model, effort }`: an exact model and effort. An unsupported pair returns 400.
 * - `POST /ops/models/discover` `{}`: lists the provider's models with the key. It costs no inference.
 * - `GET /ops/usage`: estimated paid usage and cost. `POST /ops/usage/controls`: optional warnings and limits in USD.
 * - `POST /ops/cloud` `{ suspended }`: suspends or resumes every cloud model.
 *
 * Replies hold model ids, efforts, counts, and categories. They never hold keys, tokens, or message text.
 */
export async function handleOpsPaid(req: IncomingMessage, res: ServerResponse, path: string, runtime: GatewayRuntime): Promise<boolean> {
  const reply = jsonReply(res)
  const method = req.method ?? ''
  const { paid } = runtime
  if (method === 'GET' && path === '/ops/models') {
    reply(200, paid.modelsView())
    return true
  }
  if (method === 'GET' && path === '/ops/usage') {
    reply(200, paid.usageView())
    return true
  }
  if (method !== 'POST' || !['/ops/models/select', '/ops/models/discover', '/ops/usage/controls', '/ops/cloud'].includes(path))
    return false

  const body = await readJson(req, res)
  if (body === undefined)
    return true
  switch (path) {
    case '/ops/models/select': {
      const parsed = v.safeParse(v.strictObject({ model: v.string(), effort: v.string() }), body)
      if (!parsed.success)
        return badRequest(res, 'select needs model and effort strings.')
      const result = paid.select(parsed.output.model, parsed.output.effort)
      if (result.ok)
        reply(200, { ok: true, selection: result.selection })
      else
        reply(result.status, { error: { type: 'invalid_request_error', code: result.code, message: result.message, ...(result.supported ? { supported: result.supported } : {}) } })
      return true
    }
    case '/ops/models/discover': {
      if (!v.safeParse(v.strictObject({}), body).success)
        return badRequest(res, 'discover takes an empty object.')
      const keyRef = paid.target.ok ? paid.target.provider.keyRef : undefined
      const discovery = await paid.discover(keyRef ? runtime.providerKeys.get(keyRef) : undefined)
      reply(200, { discovery })
      return true
    }
    case '/ops/usage/controls': {
      const parsed = v.safeParse(spendingPatchSchema, body)
      if (!parsed.success)
        return badRequest(res, 'Controls are USD amounts from 0 to 100000, or null.')
      reply(200, { ok: true, controls: paid.setSpending(parsed.output) })
      return true
    }
    default: {
      const parsed = v.safeParse(v.strictObject({ suspended: v.boolean() }), body)
      if (!parsed.success)
        return badRequest(res, 'suspended must be a boolean.')
      runtime.setCloudSuspended(parsed.output.suspended)
      reply(200, { ok: true, suspended: parsed.output.suspended })
      return true
    }
  }
}

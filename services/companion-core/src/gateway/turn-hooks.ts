import type { IncomingHttpHeaders } from 'node:http'

import type { InjectedUnit } from '../budget/budgeter'
import type { WireRequest } from '../budget/wire'
import type { CapturedReply } from '../companion/reply-capture'

/** How one chat request ended. Only a fully delivered answer is `complete`. */
export type TurnOutcome
  = | { status: 'complete', reply: CapturedReply }
    | { status: 'incomplete' }

/** What the companion adds to one chat request, and how it learns the result. */
export interface GatewayTurn {
  /** Memory and awareness blocks. The budgeter keeps or drops each one whole. */
  units: readonly InjectedUnit[]
  /** Called exactly once, after the response ended or failed. It must not throw or block. */
  finish: (outcome: TurnOutcome) => void
}

/**
 * The seam between the gateway and the companion runtime (memory and perception).
 * The gateway bounds `begin` with its own timeout, so a slow companion never stalls a chat request.
 */
export interface TurnHooks {
  begin: (request: { headers: IncomingHttpHeaders, body: WireRequest, signal: AbortSignal }) => Promise<GatewayTurn | undefined>
}

/** Hard upper bound for `begin`, above every configured recall deadline. */
export const TURN_BEGIN_TIMEOUT_MS = 1500

/**
 * Runs `begin` and gives up after `timeoutMs`. A failure or a late answer returns `undefined`, so the request continues
 * without companion context. A late answer still gets `finish`, so its state is released.
 */
export async function beginTurn(hooks: TurnHooks | undefined, request: Parameters<TurnHooks['begin']>[0], timeoutMs = TURN_BEGIN_TIMEOUT_MS): Promise<GatewayTurn | undefined> {
  if (!hooks)
    return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = hooks.begin(request).catch(() => undefined)
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, undefined)
  })
  const turn = await Promise.race([started, late])
  clearTimeout(timer)
  if (!turn)
    void started.then(lateTurn => lateTurn?.finish({ status: 'incomplete' }))
  return turn
}

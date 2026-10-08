import type { JellyfinClient } from './jellyfin-client'

import * as v from 'valibot'

const initiateSchema = v.object({ Code: v.pipe(v.string(), v.regex(/^\w{4,16}$/)), Secret: v.pipe(v.string(), v.regex(/^[\w-]{8,256}$/)) })
const stateSchema = v.object({ Authenticated: v.boolean() })
const authSchema = v.object({ AccessToken: v.pipe(v.string(), v.regex(/^[\w-]{16,128}$/)), User: v.optional(v.object({ Name: v.optional(v.nullable(v.string())), Policy: v.optional(v.nullable(v.object({ IsAdministrator: v.optional(v.nullable(v.boolean())) }))) })) })

export interface QuickConnectResult {
  token: string
  user?: string
  admin: boolean
}

/**
 * Gets a Jellyfin access token through Quick Connect, so the Core never handles the user's password.
 * The user enters the shown code in a Jellyfin client that is already signed in, and the token belongs to that user.
 *
 * Call stack:
 *
 * main jellyfin-connect (../../bin/run)
 *   -> {@link quickConnect}
 *     -> GET QuickConnect/Enabled -> POST QuickConnect/Initiate
 *     -> GET QuickConnect/Connect (until authorized) -> POST Users/AuthenticateWithQuickConnect
 */
export async function quickConnect(client: JellyfinClient, options: { show: (code: string) => void, now: () => number, sleep: (ms: number) => Promise<void>, timeoutMs?: number, intervalMs?: number }): Promise<QuickConnectResult> {
  const enabled = await client.get<unknown>('QuickConnect/Enabled')
  if (!enabled.ok)
    throw new Error(`The Jellyfin server did not answer (${enabled.failure}).`)
  if (enabled.data !== true)
    throw new Error('Quick Connect is off on this server. Turn it on in Dashboard > General, or store a token with secret-import.')
  const initiated = await client.post<unknown>('QuickConnect/Initiate', undefined, { token: null })
  const pending = initiated.ok ? v.safeParse(initiateSchema, initiated.data) : undefined
  if (!pending?.success)
    throw new Error(`Quick Connect did not start (${initiated.ok ? 'invalid-reply' : initiated.failure}).`)
  options.show(pending.output.Code)
  const deadline = options.now() + (options.timeoutMs ?? 300_000)
  while (true) {
    if (options.now() > deadline)
      throw new Error('Quick Connect timed out. Run the command again.')
    await options.sleep(options.intervalMs ?? 3000)
    // NOTICE:
    // Jellyfin's Quick Connect API takes the pairing secret only as a query parameter.
    // The secret is short-lived and becomes useful only after a signed-in user approves the code.
    // Source: Jellyfin.Api/Controllers/QuickConnectController.cs GetQuickConnectState([FromQuery] string secret).
    // Removal condition: Jellyfin accepts the secret in a header or body.
    const state = await client.get<unknown>('QuickConnect/Connect', { secret: pending.output.Secret })
    if (!state.ok)
      throw new Error(`Quick Connect stopped (${state.failure}).`)
    const parsed = v.safeParse(stateSchema, state.data)
    if (parsed.success && parsed.output.Authenticated)
      break
  }
  const auth = await client.post<unknown>('Users/AuthenticateWithQuickConnect', { Secret: pending.output.Secret }, { token: null })
  const result = auth.ok ? v.safeParse(authSchema, auth.data) : undefined
  if (!result?.success)
    throw new Error(`Quick Connect did not return a token (${auth.ok ? 'invalid-reply' : auth.failure}).`)
  return { token: result.output.AccessToken, user: result.output.User?.Name?.slice(0, 64) ?? undefined, admin: result.output.User?.Policy?.IsAdministrator === true }
}

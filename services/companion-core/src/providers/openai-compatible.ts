import type { ProviderConfig } from '../config/config'

/**
 * Sends one chat-completions request body to an OpenAI-compatible provider.
 *
 * The body is forwarded as given. Only the provider credential is attached here. Client headers such as
 * `Authorization`, `Origin`, and `Cookie` are never copied, so the gateway token never leaves the machine.
 * `accept-encoding: identity` keeps server-sent events uncompressed, so the provider cannot hold
 * small events back in a compression buffer.
 */
export function sendChatCompletion(input: {
  provider: ProviderConfig
  apiKey: string
  body: string
  signal: AbortSignal
}): Promise<Response> {
  return fetch(new URL('chat/completions', input.provider.baseURL), {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/event-stream',
      'accept-encoding': 'identity',
      'authorization': `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: input.body,
    signal: input.signal,
  })
}

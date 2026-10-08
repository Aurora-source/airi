import * as v from 'valibot'

import { sse, startFakeProvider, startRoutedGateway, TEST_INFERENCE_TOKEN, writeEvents } from '../../test/support/harness'
import { GatewayClient } from '../persona/client'

const request = { model: 'fixture-chat', messages: [{ role: 'user', content: 'Synthetic cancellation and failover fixture.' }], max_tokens: 64, stream: true }

async function fixtureGateway(baseURL: string, chain: string[]) {
  return startRoutedGateway({
    profile: 'cloud',
    memory: { enabled: false },
    channel: { enabled: false },
    perception: { enabled: false },
    watch: { enabled: false },
    providers: { fake: { baseURL, keyRef: 'key-fake', locality: 'cloud' } },
    models: Object.fromEntries(chain.map(id => [id, { provider: 'fake', model: id, capabilities: { contextWindow: 10000 } }])),
    aliases: { 'fixture-chat': { chain } },
  })
}

function headers() {
  return { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'application/json' }
}

async function closedWithin(closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture peer did not close')), 2000)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

/** Measures real loopback cancellation, failover, and retry timing with existing Gateway fixtures. No cloud endpoint or credential is used. */
export async function measureFixtures(count = 3) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5)
    throw new Error('Fixture count is outside its bound')
  const cancellation: { abortToPeerCloseMs: number, peerClosed: boolean }[] = []
  const failover: { status: number, servedBy: string | null, firstByteMs: number, attemptGapMs: number, attempts: string[] }[] = []
  const retry: { status: number, requestedWaitMs: number, measuredSleepMs: number, otherElapsedMs: number }[] = []
  for (let index = 0; index < count; index++) {
    const provider = await startFakeProvider()
    const { gateway } = await fixtureGateway(provider.baseURL, ['first', 'second'])
    try {
      provider.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse({ choices: [{ delta: { content: '<|ACT {"emotion":"happy"}|> Hello' } }] }))
      })
      const controller = new AbortController()
      const response = await fetch(`${gateway.baseURL}chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(request), signal: controller.signal })
      const reader = response.body!.getReader()
      await reader.read()
      const aborted = performance.now()
      controller.abort()
      await closedWithin(provider.requests[0].closed)
      cancellation.push({ abortToPeerCloseMs: performance.now() - aborted, peerClosed: true })
      reader.releaseLock()
      provider.requests.length = 0
      const arrivals: number[] = []
      provider.setHandler((_req, res, received) => {
        arrivals.push(performance.now())
        if (v.parse(v.object({ model: v.string() }), JSON.parse(received.body)).model === 'first') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"synthetic transient failure"}}')
          return
        }
        void writeEvents(res, [sse({ choices: [{ delta: { content: '<|ACT {"emotion":"happy"}|> Recovered.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }), sse('[DONE]')])
      })
      const started = performance.now()
      const recovered = await fetch(`${gateway.baseURL}chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(request), signal: AbortSignal.timeout(10000) })
      const firstByteMs = performance.now() - started
      await recovered.text()
      failover.push({ status: recovered.status, servedBy: recovered.headers.get('x-companion-model'), firstByteMs, attemptGapMs: arrivals[1] - arrivals[0], attempts: [...gateway.runtime.recentRoutes().findLast(route => route.modelId === 'second')!.attempts] })
    }
    finally {
      await gateway.close()
      await provider.close()
    }
    const retryProvider = await startFakeProvider()
    const { gateway: retryGateway } = await fixtureGateway(retryProvider.baseURL, ['first'])
    let receivedCount = 0
    let measuredSleepMs = 0
    retryProvider.setHandler((_req, res) => {
      if (++receivedCount === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end('{"error":{"message":"synthetic rate limit"}}')
        return
      }
      void writeEvents(res, [sse({ choices: [{ delta: { content: '<|ACT {"emotion":"happy"}|> Hello.' }, finish_reason: 'stop' }] }), sse('[DONE]')])
    })
    try {
      const client = new GatewayClient({ baseURL: retryGateway.baseURL.replace('v1/', ''), token: TEST_INFERENCE_TOKEN, maxWaitMs: 5000, sleep: async (ms) => {
        const started = performance.now()
        await new Promise(resolve => setTimeout(resolve, ms))
        measuredSleepMs += performance.now() - started
      } })
      const result = await client.complete('fixture-chat', request)
      retry.push({ status: result.status, requestedWaitMs: result.waitedMs, measuredSleepMs, otherElapsedMs: result.totalMs - measuredSleepMs })
    }
    finally {
      await retryGateway.close()
      await retryProvider.close()
    }
  }
  return { paidCalls: 0, mode: 'loopback fixtures, not Gemini or physical voice', cancellation, failover, retry }
}

import { describe, expect, it } from 'vitest'

import { ConversationLedger } from '../src/companion/conversation-ledger'

describe('conversationLedger first speech latency', () => {
  it('measures from the first request of a round to its first speech report, once per round', () => {
    let now = 1000
    const ledger = new ConversationLedger(() => now)
    const turn = { sessionId: 's', roundId: 'round-1', characterId: 'c' }

    const first = ledger.open(turn)
    now = 1800
    // A tool round of the same round does not restart the clock.
    ledger.open(turn).finish(false)
    now = 2600
    first.finish(true)
    ledger.speech('round-1', 's', true)
    now = 4000
    ledger.speech('round-1', 's', false)
    ledger.speech('round-1', 's', true)

    expect(ledger.status().firstSpeech).toMatchObject({ samples: 1, p50Ms: 1600, p95Ms: null, lastMs: 1600, recentMs: [1600] })
  })

  it('ignores speech of an unknown turn and keeps no ids in the status', () => {
    const ledger = new ConversationLedger(() => 0)
    ledger.open({ sessionId: 'secret-session', roundId: 'secret-round', characterId: 'secret-card' })

    ledger.speech('other-round', undefined, true)

    expect(ledger.status().firstSpeech.samples).toBe(0)
    expect(JSON.stringify(ledger.status())).not.toContain('secret')
  })
})

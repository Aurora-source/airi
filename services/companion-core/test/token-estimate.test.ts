import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createTokenEstimator } from '../src/budget/estimate'

const AIRI_TOOLS = JSON.parse(readFileSync(new URL('./fixtures/airi-tools.json', import.meta.url), 'utf8')) as unknown[]

/**
 * Token counts that the Gemini `countTokens` endpoint returned for `gemini-3.5-flash-lite` on 2026-10-07.
 * The estimator must stay on the safe side: never below the real count, and not far above it.
 */
const MEASURED = {
  toolsJson: { text: JSON.stringify(AIRI_TOOLS), tokens: 1817 },
  casualChat: {
    text: 'Hey Mura, you won\'t believe it, I finally got the build passing after three hours of chasing that stupid race condition! It turned out to be a missing await in the retry helper. Anyway, I\'m so tired but happy. Do you want to watch something together tonight? Maybe that mecha anime you kept recommending, the one with the giant robot and the sad pilot who never says what he feels. I promise I\'ll stay awake this time, probably.'.repeat(6),
    tokens: 583,
  },
  japanese: {
    text: '今日はとても疲れたけど、やっとビルドが通ったよ！三時間もかかったけど、原因は小さなバグだった。一緒にアニメを見ようか？前に勧めてくれたロボットのやつ、あの寡黙なパイロットが出てくる作品が気になってるんだ。眠くならないように頑張るね。'.repeat(12),
    tokens: 793,
  },
}

describe('token estimator', () => {
  const estimator = createTokenEstimator()

  it.each(Object.entries(MEASURED))('keeps %s between the real count and 1.6 times the real count', (_name, sample) => {
    const estimate = estimator.text(sample.text)

    expect(estimate).toBeGreaterThanOrEqual(sample.tokens)
    expect(estimate).toBeLessThanOrEqual(sample.tokens * 1.6)
  })

  it('counts CJK text at about one token per character and not per four characters', () => {
    const japanese = estimator.text('あ'.repeat(400))
    const latin = estimator.text('a'.repeat(400))

    expect(japanese).toBeGreaterThan(latin * 2)
  })

  it('counts an empty string as zero tokens', () => {
    expect(estimator.text('')).toBe(0)
  })

  it('counts an image part at the fixed image cost and never reads the data URI', () => {
    const hugeDataUri = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`
    const started = performance.now()

    const tokens = estimator.content([
      { type: 'text', text: 'what color is this?' },
      { type: 'image_url', image_url: { url: hugeDataUri } },
    ])

    expect(tokens).toBeLessThan(estimator.imageTokens + 50)
    expect(tokens).toBeGreaterThanOrEqual(estimator.imageTokens)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('counts tool-call arguments and tool result text of a message', () => {
    const message = estimator.message({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Osaka"}' } }],
    })

    expect(message).toBeGreaterThan(estimator.text('get_weather') + estimator.text('{"location":"Osaka"}'))
  })

  it('scales every estimate by the calibration ratio learned from provider usage', () => {
    const calibrated = createTokenEstimator({ calibration: 0.8 })

    expect(calibrated.text(MEASURED.casualChat.text)).toBeLessThan(estimator.text(MEASURED.casualChat.text))
    expect(calibrated.text(MEASURED.casualChat.text)).toBeGreaterThan(estimator.text(MEASURED.casualChat.text) * 0.7)
  })
})

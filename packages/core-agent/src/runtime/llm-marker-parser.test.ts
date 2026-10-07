import { describe, expect, it } from 'vitest'

import { useLlmmarkerParser } from './llm-marker-parser'

/**
 * @example
 * const parser = useLlmmarkerParser({ onLiteral, onSpecial })
 */
describe('useLlmmarkerParser', () => {
  /**
   * @example
   * Plain model text is emitted as literal output.
   */
  it('parses pure literals', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('Hello, world!')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello, world!')
  })

  /**
   * @example
   * `<|...|>` markers are emitted as special output.
   */
  it('parses special markers separately from literals', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('Hello <|ACT|> world')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello  world')
    expect(collectedSpecials).toEqual(['<|ACT|>'])
  })

  /**
   * @example
   * Unfinished markers are withheld instead of leaking into literal text.
   */
  it('does not include unfinished special markers', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('<|unfinished')
    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })
})

/** Feeds text in chunks of `size` characters, the way a provider stream splits markers. */
async function parse(text: string, size = text.length) {
  const literals: string[] = []
  const specials: string[] = []
  const parser = useLlmmarkerParser({
    onLiteral: (literal) => {
      literals.push(literal)
    },
    onSpecial: (special) => {
      specials.push(special)
    },
  })
  for (let index = 0; index < text.length; index += size)
    await parser.consume(text.slice(index, index + size))
  await parser.end()
  return { literal: literals.join(''), specials }
}

const ACT_PAYLOAD = '{"emotion":{"name":"happy","intensity":0.8},"motion":"nod"}'

describe('useLlmmarkerParser ACT closers', () => {
  // Each closer below appeared after an ACT payload in the R2B persona benchmark (Gemini and Groq models).
  // Without tolerance, the marker never closes, so the speech after it is withheld or dropped.
  it.each(['%>', '#>', '@>', '!>', '>', '-->', '//>', '||>', '~|>', '!|>', '|\uFE0F>'])('closes an ACT marker that ends with %j after its payload', async (closer) => {
    for (const size of [1, 4, 1000]) {
      const result = await parse(`<|ACT ${ACT_PAYLOAD}${closer} Hello there! <|DELAY 1|> Bye.`, size)

      expect(result.literal).toBe(' Hello there!  Bye.')
      expect(result.specials).toEqual([`<|ACT ${ACT_PAYLOAD}|>`, '<|DELAY 1|>'])
    }
  })

  it('closes a mistyped ACT closer at the end of the stream', async () => {
    const result = await parse(`Hi <|ACT ${ACT_PAYLOAD}%>`, 3)

    expect(result.literal).toBe('Hi ')
    expect(result.specials).toEqual([`<|ACT ${ACT_PAYLOAD}|>`])
  })

  it('keeps a well-formed ACT marker byte for byte, including space before the closer', async () => {
    const result = await parse(`<|ACT ${ACT_PAYLOAD} |> Hi`, 2)

    expect(result.specials).toEqual([`<|ACT ${ACT_PAYLOAD} |>`])
    expect(result.literal).toBe(' Hi')
  })

  it('ignores closer characters inside payload strings', async () => {
    const payload = '{"motion":"wave }> and %> and \\"}>\\""}'
    const result = await parse(`<|ACT ${payload}|> Hi`, 1)

    expect(result.specials).toEqual([`<|ACT ${payload}|>`])
    expect(result.literal).toBe(' Hi')
  })

  it('keeps the standard closer for an ACT payload whose braces do not balance', async () => {
    const result = await parse('<|ACT {"emotion":{"name":"happy"},"motion":"nod"|> Hi', 2)

    expect(result.specials).toEqual(['<|ACT {"emotion":{"name":"happy"},"motion":"nod"|>'])
    expect(result.literal).toBe(' Hi')
  })

  it('does not guess a closer when ordinary text follows the payload', async () => {
    const result = await parse(`<|ACT ${ACT_PAYLOAD} Hi |> there`, 2)

    expect(result.specials).toEqual([`<|ACT ${ACT_PAYLOAD} Hi |>`])
    expect(result.literal).toBe(' there')
  })

  it('leaves the closers of other markers unchanged', async () => {
    const result = await parse('<|DELAY 1%> Hi', 1)

    expect(result.specials).toEqual([])
    expect(result.literal).toBe('')
  })

  it('keeps ordinary text with angle brackets as literal text', async () => {
    const result = await parse('3 > 2 and {"a":1}%> stays text', 1)

    expect(result.specials).toEqual([])
    expect(result.literal).toBe('3 > 2 and {"a":1}%> stays text')
  })
})

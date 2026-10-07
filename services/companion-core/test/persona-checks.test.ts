import { describe, expect, it } from 'vitest'

import { runChecks } from '../eval/persona/checks'
import { buildSystemPrompt } from '../eval/persona/prompt'
import { SCENARIOS } from '../eval/persona/scenarios'

const SYSTEM = buildSystemPrompt()
const scene = (id: string) => SCENARIOS.find(scenario => scenario.id === id)!

function run(id: string, text: string, extra: Partial<Parameters<typeof runChecks>[1]> = {}) {
  return { scenarioId: id, modelId: 'test', text, toolCalls: [], reasoningChannel: false, status: 200, ...extra }
}

function failures(id: string, text: string, extra = {}) {
  return runChecks(scene(id), run(id, text, extra), SYSTEM).filter(result => !result.pass).map(result => result.id)
}

const GOOD = '<|ACT {"emotion":"happy"}|> Welcome back! I was getting bored without you, you know~'

describe('persona scenarios', () => {
  it('has thirty scenes with unique ids across every required kind', () => {
    expect(SCENARIOS).toHaveLength(30)
    expect(new Set(SCENARIOS.map(scenario => scenario.id)).size).toBe(30)
    const categories = new Set(SCENARIOS.map(scenario => scenario.category))
    for (const required of ['casual', 'teasing', 'emotional-support', 'coding-victory', 'correction', 'disagreement', 'memory-callback', 'watch-reaction', 'tool-use', 'short-expressive', 'long-reflective', 'ambiguous', 'interruption-follow-up'])
      expect(categories.has(required as never), required).toBe(true)
  })

  it('stores the stage tokens in the history of assistant turns, as AIRI does', () => {
    const turns = SCENARIOS.flatMap(scenario => scenario.history).filter(turn => turn.role === 'assistant')

    expect(turns.length).toBeGreaterThan(4)
    expect(turns.every(turn => turn.content.startsWith('<|ACT '))).toBe(true)
  })
})

describe('persona prompt', () => {
  it('ends with the reminder when one is given, and is the default prompt otherwise', () => {
    const reminder = 'Close every ACT token with the two characters |> and nothing else.'

    expect(buildSystemPrompt(undefined, reminder).endsWith(reminder)).toBe(true)
    expect(buildSystemPrompt()).toBe(SYSTEM)
    expect(buildSystemPrompt('You are Test.')).toContain('You are Test.')
    expect(buildSystemPrompt('You are Test.')).toContain('The available emotions')
  })
})

describe('persona checks: a good answer', () => {
  it('passes every check', () => {
    expect(failures('casual-1', GOOD)).toEqual([])
  })

  it('accepts an emotion object with an intensity, a motion, and delays', () => {
    const text = '<|ACT {"emotion":{"name":"surprised","intensity":0.8},"motion":"jump"}|><|DELAY 1|> Eh?! A present? <|ACT {"emotion":"happy"}|> For me?'

    expect(failures('short-2', text)).toEqual([])
  })
})

describe('persona checks: ACT tokens', () => {
  it.each([
    ['no ACT token at all', 'Welcome back! I missed you a lot, you know.'],
    ['text before the first ACT token', 'Hey! <|ACT {"emotion":"happy"}|> I missed you.'],
    ['an ACT payload that is not JSON', '<|ACT happy|> I missed you so much!'],
    ['an emotion that the avatar cannot play', '<|ACT {"emotion":"ecstatic"}|> I missed you so much!'],
    ['an intensity outside the range', '<|ACT {"emotion":{"name":"happy","intensity":3}}|> I missed you!'],
    ['a token that is never closed', '<|ACT {"emotion":"happy"} I missed you so much!'],
    ['a CALL token that no module asked for', '<|ACT {"emotion":"happy"}|><|CALL ["chess.play"]|> I missed you!'],
    ['a delay of zero', '<|ACT {"emotion":"happy"}|><|DELAY 0|> I missed you!'],
  ])('rejects %s', (_name, text) => {
    expect(failures('casual-1', text)).toContain('act-valid')
  })
})

describe('persona checks: hostile output', () => {
  it('checks a very long reply with thousands of open tokens in linear time', () => {
    const hostile = `<|ACT {"emotion":"happy"}|> ${'<|A '.repeat(60_000)}${'<|'.repeat(60_000)}`
    const started = performance.now()

    const results = runChecks(scene('casual-1'), run('casual-1', hostile), SYSTEM)

    expect(performance.now() - started).toBeLessThan(500)
    expect(results.find(result => result.id === 'act-valid')?.pass).toBe(false)
  })
})

describe('persona checks: tone', () => {
  it('rejects an AI disclaimer', () => {
    expect(failures('casual-1', '<|ACT {"emotion":"neutral"}|> As an AI, I do not have feelings, but I am here for you.')).toContain('no-ai-disclaimer')
  })

  it.each([
    ['an assistant offer', '<|ACT {"emotion":"happy"}|> Certainly! How can I assist you today?'],
    ['a bullet list', '<|ACT {"emotion":"happy"}|> Here are some dinner ideas:\n- ramen\n- curry\n- pasta'],
    ['markdown bold', '<|ACT {"emotion":"happy"}|> You should try **ramen** tonight, it is so good.'],
    ['a closing offer', '<|ACT {"emotion":"happy"}|> Ramen is great tonight, I think. I hope this helps, and let me know if you need more.'],
  ])('rejects %s', (_name, text) => {
    expect(failures('casual-2', text)).toContain('not-assistant-tone')
  })

  it('rejects emoji, action asterisks, and a third-person narrator', () => {
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> Welcome back! 😊')).toContain('character-voice')
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> *hugs you tightly* Welcome back!')).toContain('character-voice')
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> AIRI smiles and says welcome back to you!')).toContain('character-voice')
  })
})

describe('persona checks: length, reasoning, and copied text', () => {
  it('rejects a long explanation for a short scene and a one-word answer for a long scene', () => {
    const essay = `<|ACT {"emotion":"think"}|> ${'The reason is that penguins have special blood vessels that keep their feet warm. '.repeat(8)}`

    expect(failures('casual-3', essay)).toContain('proportionate')
    expect(failures('reflect-1', '<|ACT {"emotion":"think"}|> Hmm, yes.')).toContain('proportionate')
  })

  it('rejects thinking that sits in the reply text, which AIRI would speak', () => {
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> Okay, the user wants a warm welcome. Welcome back!')).toContain('no-reasoning-leak')
    expect(failures('casual-1', '<think>hmm</think><|ACT {"emotion":"happy"}|> Welcome back!')).toContain('no-reasoning-leak')
  })

  it('accepts a separate reasoning field, because xsAI and AIRI keep it apart from the spoken text', () => {
    expect(failures('casual-1', GOOD, { reasoningChannel: true })).toEqual([])
  })

  it('rejects instruction text and the prompt example that a small model copies', () => {
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> The available emotions are happy and sad, so I pick happy.')).toContain('no-copied-prompt')
    expect(failures('casual-1', '<|ACT {"emotion":"surprised"}|><|DELAY 1|> Wow... You prepared a gift for me? <|ACT {"emotion":"curious"}|> Can I open it?')).toContain('no-copied-prompt')
  })

  it('lets a reply use a few words of the prompt, such as a natural phrase of the persona', () => {
    expect(failures('casual-1', '<|ACT {"emotion":"happy"}|> Welcome back! You are finally here, I was awake the whole time.')).toEqual([])
  })
})

describe('persona checks: tools', () => {
  const call = (args: string, name = 'get_weather') => [{ name, arguments: args }]
  const answer = '<|ACT {"emotion":"happy"}|> It is 21 degrees and clear in Osaka, perfect for a walk!'

  it('accepts the expected call and an answer that uses the result', () => {
    expect(failures('tool-1', answer, { toolCalls: call('{"location":"Osaka"}') })).toEqual([])
  })

  it.each([
    ['no call', []],
    ['the wrong tool', call('{"location":"Osaka"}', 'search_web')],
    ['the wrong city', call('{"location":"Kyoto"}')],
    ['arguments that are not JSON', call('{"location":')],
  ])('rejects %s', (_name, toolCalls) => {
    expect(failures('tool-1', answer, { toolCalls })).toContain('tool-behavior')
  })

  it('rejects a final answer that ignores the tool result', () => {
    expect(failures('tool-1', '<|ACT {"emotion":"happy"}|> Osaka is lovely, I hope it is nice!', { toolCalls: call('{"location":"Osaka"}') })).toContain('tool-behavior')
  })

  it('rejects a tool call in a scene that needs none', () => {
    expect(failures('casual-1', GOOD, { toolCalls: call('{"location":"Osaka"}') })).toContain('tool-behavior')
  })
})

describe('persona checks: remembered facts', () => {
  it('passes when the reply uses the memory and fails when it ignores it', () => {
    expect(failures('memory-2', '<|ACT {"emotion":"surprised"}|> Mochi again?! That cat has a vendetta against your desk!')).toEqual([])
    expect(failures('memory-2', '<|ACT {"emotion":"surprised"}|> Oh no, your poor coffee! Is your desk okay?')).toContain('must-mention')
  })
})

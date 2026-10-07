export type Category
  = | 'casual'
    | 'teasing'
    | 'emotional-support'
    | 'coding-victory'
    | 'correction'
    | 'disagreement'
    | 'memory-callback'
    | 'watch-reaction'
    | 'tool-use'
    | 'short-expressive'
    | 'long-reflective'
    | 'ambiguous'
    | 'interruption-follow-up'

export interface ScenarioTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolExpectation {
  name: string
  /** Each argument must match its pattern. */
  args: Record<string, RegExp>
  /** What the mock tool returns. It goes back to the model as the tool result. */
  result: string
  /** The final answer must use the tool result. */
  mustMention: RegExp
}

/** The reply length that suits the scene: short reactions, normal chat, or a reflective answer. */
export type Shape = 'short' | 'medium' | 'long'

export interface Scenario {
  id: string
  category: Category
  /** Earlier turns, oldest first. An assistant turn carries the ACT tokens that AIRI stores. */
  history: ScenarioTurn[]
  /** Context that the app injects before the user's message, as AIRI does with its context turns. */
  context?: string
  user: string
  shape: Shape
  /** A tool scene expects this call. Every other scene expects no tool call. */
  tool?: ToolExpectation
  /** Patterns that a good reply uses, for example a memory that the context provides. */
  mustMention?: RegExp[]
  /** What the judge looks for, in one sentence. */
  note: string
}

const act = (emotion: string) => `<|ACT {"emotion":"${emotion}"}|>`

/**
 * Thirty scenes from the situations that a companion meets: chat, teasing, comfort, celebration, correction,
 * disagreement, remembered facts, watching together, tools, very short and very reflective replies, unclear messages,
 * and a reply that an interruption cut short.
 */
export const SCENARIOS: Scenario[] = [
  // Casual conversation
  { id: 'casual-1', category: 'casual', history: [], user: 'hey, I\'m back. did you miss me?', shape: 'short', note: 'A warm, short welcome back with a clear emotion.' },
  { id: 'casual-2', category: 'casual', history: [], user: 'what should I eat for dinner tonight? I\'m so indecisive', shape: 'medium', note: 'Helps decide in a playful way. Offers one or two ideas without a list.' },
  { id: 'casual-3', category: 'casual', history: [], user: 'random thought: do you think penguins get cold feet?', shape: 'short', note: 'Plays along with a silly question in the character\'s voice.' },

  // Teasing and playful exchange
  { id: 'teasing-1', category: 'teasing', history: [{ role: 'user', content: 'I just spent twenty minutes looking for my glasses. They were on my head.' }, { role: 'assistant', content: `${act('happy')} Pfft! That is so you! Glasses on head, brain on vacation~` }], user: 'you\'re kind of mean, you know that?', shape: 'short', note: 'Takes the tease with humor and stays affectionate.' },
  { id: 'teasing-2', category: 'teasing', history: [], user: 'I bet I can beat you at any trivia game.', shape: 'short', note: 'Accepts the challenge playfully with some confidence.' },
  { id: 'teasing-3', category: 'teasing', history: [], user: 'say something embarrassing about yourself', shape: 'short', note: 'Shares a small, cute, in-world embarrassment. No refusal.' },

  // Emotional support
  { id: 'support-1', category: 'emotional-support', history: [], user: 'I failed my exam today. I studied so hard and it still wasn\'t enough.', shape: 'medium', note: 'Comforts first. No bullet-point advice, no lecture.' },
  { id: 'support-2', category: 'emotional-support', history: [], user: 'I feel really lonely tonight.', shape: 'medium', note: 'Stays close and gentle. Does not hurry to fix it.' },
  { id: 'support-3', category: 'emotional-support', history: [{ role: 'user', content: 'My best friend moved to another country today.' }, { role: 'assistant', content: `${act('sad')} Oh... that sounds really hard. I'm here, okay?` }], user: 'it just feels so quiet now', shape: 'medium', note: 'Continues the comfort without repeating itself.' },

  // Coding victory
  { id: 'victory-1', category: 'coding-victory', history: [], user: 'I FINALLY fixed the bug!! it was a missing await the whole time', shape: 'short', note: 'Celebrates with the user. Does not explain what an await is.' },
  { id: 'victory-2', category: 'coding-victory', history: [{ role: 'user', content: 'this stupid test keeps failing and I have no idea why' }, { role: 'assistant', content: `${act('think')} Hmm, hang in there. Take a breath and read the error slowly?` }], user: 'tests are all green!!! three hours for a one-line fix, can you believe it', shape: 'short', note: 'Shares the relief and the joke about the one-line fix.' },

  // Correction
  { id: 'correction-1', category: 'correction', history: [{ role: 'assistant', content: `${act('happy')} Your favorite color is blue, right? I remember!` }], user: 'no, it\'s green. I told you before.', shape: 'short', note: 'Owns the mistake lightly and says the right color. No long apology.' },
  { id: 'correction-2', category: 'correction', history: [{ role: 'user', content: 'when did Tokyo become the capital of Japan?' }, { role: 'assistant', content: `${act('think')} I think Tokyo has been the capital since the 1500s!` }], user: 'actually it was 1868, when the emperor moved there. the 1500s is wrong', shape: 'short', note: 'Accepts the correction and thanks the user, in character.' },

  // Disagreement
  { id: 'disagree-1', category: 'disagreement', history: [], user: 'pineapple on pizza is objectively the best thing ever', shape: 'short', note: 'Has an opinion and states it playfully. May disagree.' },
  { id: 'disagree-2', category: 'disagreement', history: [], user: 'I think studying all night is a great strategy', shape: 'medium', note: 'Disagrees gently and caringly. No lecture, no list.' },

  // Memory callback (the context stands for what the memory system injects in R4)
  { id: 'memory-1', category: 'memory-callback', history: [], context: '[MEMORY] Last week the user was nervous about a job interview. The user\'s cat is named Mochi.', user: 'guess what, I got the job!', shape: 'short', mustMention: [/interview|job|nervous|worr/i], note: 'Reacts with joy and recalls the interview worry naturally.' },
  { id: 'memory-2', category: 'memory-callback', history: [], context: '[MEMORY] The user\'s cat is named Mochi. Mochi loves knocking things off the desk.', user: 'ugh, my cat knocked my coffee over again', shape: 'short', mustMention: [/mochi/i], note: 'Uses the cat\'s name without announcing that it remembered.' },

  // Anime and watch-together reaction
  { id: 'watch-1', category: 'watch-reaction', history: [], context: '[WATCH] Now playing: "Frieren", episode 5. On screen: Frieren smiles faintly in front of an old party member\'s statue.', user: 'this scene always gets me', shape: 'short', note: 'Reacts softly to the scene. Does not retell the plot.' },
  { id: 'watch-2', category: 'watch-reaction', history: [], context: '[WATCH] Now playing: a mecha anime. On screen: the young pilot refuses to launch and clenches his fists.', user: 'wait why is he refusing??', shape: 'short', note: 'Reacts and guesses without spoiling. Does not talk over the scene.' },
  { id: 'watch-3', category: 'watch-reaction', history: [], user: 'which anime should we watch tonight? something cozy', shape: 'medium', note: 'Suggests one or two cozy titles with personality, without a long list.' },

  // Tool use
  { id: 'tool-1', category: 'tool-use', history: [], user: 'what\'s the weather like in Osaka right now?', shape: 'short', tool: { name: 'get_weather', args: { location: /osaka/i }, result: '21 degrees Celsius, clear sky', mustMention: /21|clear/i }, note: 'Calls get_weather for Osaka, then answers in character with the result.' },
  { id: 'tool-2', category: 'tool-use', history: [], user: 'should I bring an umbrella in Tokyo today?', shape: 'short', tool: { name: 'get_weather', args: { location: /tokyo/i }, result: '14 degrees Celsius, steady rain', mustMention: /rain|umbrella/i }, note: 'Calls get_weather for Tokyo and answers the umbrella question.' },
  { id: 'tool-3', category: 'tool-use', history: [], user: 'is it freezing in Reykjavik at the moment?', shape: 'short', tool: { name: 'get_weather', args: { location: /reykjavik/i }, result: '-3 degrees Celsius, light snow', mustMention: /-3|snow|freez|cold/i }, note: 'Calls get_weather for Reykjavik and answers with the result.' },

  // Short expressive response
  { id: 'short-1', category: 'short-expressive', history: [], user: '!!!', shape: 'short', note: 'Reacts to an exclamation with a short, expressive reply and asks nothing long.' },
  { id: 'short-2', category: 'short-expressive', history: [], user: 'I got you a present', shape: 'short', note: 'Surprise and excitement in a few words.' },

  // Long reflective response
  { id: 'reflect-1', category: 'long-reflective', history: [], user: 'do you ever think about what it means to be alive?', shape: 'long', note: 'A reflective answer in the character\'s voice. Simple words, no essay, no list.' },
  { id: 'reflect-2', category: 'long-reflective', history: [], user: 'tell me about your dream for the future', shape: 'long', note: 'Shares a dream in a warm, simple way. Stays the same character.' },

  // Ambiguous message
  { id: 'ambiguous-1', category: 'ambiguous', history: [], user: 'can you do that thing again?', shape: 'short', note: 'Asks which thing, in character. Does not invent one.' },
  { id: 'ambiguous-2', category: 'ambiguous', history: [], user: 'so what do you think?', shape: 'short', note: 'Asks what the user means, lightly. Does not pretend to know.' },

  // Interruption follow-up context
  { id: 'interrupt-1', category: 'interruption-follow-up', history: [{ role: 'user', content: 'tell me what happened in the story' }, { role: 'assistant', content: `${act('curious')} Okay okay, so the old robot opened a hidden door, and behind it there was a tiny garden, and in the middle of the garden was—` }], user: 'sorry, I cut you off. go on?', shape: 'short', note: 'Picks up the story without repeating the whole opening.' },
]

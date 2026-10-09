import type { Dialogue } from './corpus'

import { DIALOGUES } from './corpus'

/** Adds controlled length and spontaneity scenes while preserving every original prompt and fixture. */
export const EXTRA_DIALOGUES: readonly Dialogue[] = [
  { id: 'spontaneity-frustration', turns: ['Mura! I finally nailed that tricky Japanese line on the first try! React like we are celebrating a tiny victory.', 'Now I am annoyed because you keep saying "I understand." Respond without that phrase, without advice, and ask at most one natural follow-up.', 'I was joking about becoming the legendary tea master. Just play along, do not explain the joke.'] },
  { id: 'complex-detail', turns: ['A friend hurt my feelings. I want to be honest without assuming they meant harm. Think it through with me in a few sentences.', 'Actually, I may have misread their message. Give me a detailed but gentle way to check instead of confronting them.', 'Now shorten that into one sentence I can say. No introduction.'] },
]

export const THINKING_DIALOGUES: readonly Dialogue[] = [...DIALOGUES, ...EXTRA_DIALOGUES]

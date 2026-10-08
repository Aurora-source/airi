import type { ScreenFrame } from '../perception/ports/contracts'

/**
 * Apps whose windows count as classified. A window of any other app has no safety classification, so automatic
 * upload stays blocked for it (R5 treats unknown as deny). A manual `look_now` can authorize it for one request.
 */
const CLASSIFIED_APPS = [
  'msedge',
  'chrome',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  'code',
  'cursor',
  'windsurf',
  'devenv',
  'idea64',
  'pycharm64',
  'webstorm64',
  'notepad',
  'notepad++',
  'sublime_text',
  'windowsterminal',
  'cmd',
  'powershell',
  'pwsh',
  'explorer',
  'vlc',
  'mpc-hc64',
  'mpc-be64',
  'mpv',
  'jellyfinmediaplayer',
  'potplayermini64',
  'stage-tamagotchi',
  'obs64',
  'spotify',
]

/** Password managers, mail, chat, and remote desktop. Their windows always count as sensitive. */
const SENSITIVE_APPS = [
  'keepass',
  'keepassxc',
  '1password',
  'bitwarden',
  'lastpass',
  'dashlane',
  'enpass',
  'keeper',
  'authy',
  'outlook',
  'olk',
  'thunderbird',
  'discord',
  'slack',
  'teams',
  'ms-teams',
  'whatsapp',
  'telegram',
  'signal',
  'zoom',
  'mstsc',
]

const PRIVATE_TITLE = /\b(?:inprivate|incognito|private browsing|private window)\b/i
const SENSITIVE_TITLE = /\b(?:password|passcode|one-time code|2fa|two-factor|authenticator|bank|banking|wallet|credit card|checkout|log ?in|sign ?in|tax return|medical)\b/i

export interface SafetyLists {
  classifiedApps?: readonly string[]
  sensitiveApps?: readonly string[]
}

/** What the capture backend knows about the foreground window. `locked` is absent when the backend cannot tell. */
export interface WindowFacts {
  app?: string
  title?: string
  locked?: boolean
}

/**
 * Classifies the safety signals of one frame. A signal stays absent when it is not known, so R5's privacy gate denies
 * automatic upload. It never marks a window safe because a signal is missing.
 *
 * @example
 * classifyWindow({ app: 'Code', title: 'main.ts', locked: false })
 * // => { locked: false, private_context: false, sensitive: false }
 */
export function classifyWindow(facts: WindowFacts, lists: SafetyLists = {}): ScreenFrame['safety'] {
  const app = facts.app?.toLowerCase()
  const title = facts.title ?? ''
  const classified = new Set([...CLASSIFIED_APPS, ...(lists.classifiedApps ?? []).map(name => name.toLowerCase())])
  const sensitive = new Set([...SENSITIVE_APPS, ...(lists.sensitiveApps ?? []).map(name => name.toLowerCase())])
  const known = app !== undefined && classified.has(app)
  const safety: ScreenFrame['safety'] = {}
  if (facts.locked !== undefined)
    safety.locked = facts.locked
  if (PRIVATE_TITLE.test(title))
    safety.private_context = true
  else if (known)
    safety.private_context = false
  if ((app !== undefined && sensitive.has(app)) || SENSITIVE_TITLE.test(title))
    safety.sensitive = true
  else if (known)
    safety.sensitive = false
  return safety
}

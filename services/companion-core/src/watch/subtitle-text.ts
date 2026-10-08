/** Dialogue is spoken text. A sign is on-screen text (shop names, title cards). A song line is sung lyrics. */
export type CueKind = 'dialogue' | 'sign' | 'song'

export interface SubtitleLine {
  kind: CueKind
  text: string
}

/** Upper bound of one current subtitle, the same bound that browser captions get. */
const MAX_SUBTITLE_CHARS = 320
const MAX_SUBTITLE_LINES = 6
/** Direction marks and byte order marks that players insert. They carry no text. Emoji joiners stay. */
const INVISIBLE_MARKS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** Style, name, or effect labels that fansub typesetters use for lyrics. */
const SONG_LABEL = /(?:^|[\s_-])(?:op|ed|song|lyrics?|kara(?:oke)?|insert|opening|ending|romaji|kanji)(?:$|[\s_\d-])/i
/** Labels for on-screen text. */
const SIGN_LABEL = /(?:^|[\s_-])(?:signs?|title|typeset|ts|screen|note|card|logo|caption|eyecatch|preview|next)(?:$|[\s_\d-])/i
/** Labels of ordinary dialogue styles. Positioned lines in these styles stay dialogue. */
const DIALOGUE_STYLE = /default|main|dialog(?:ue)?|italics?|flashback|overlap|top|alt|narrat|thought|internal|bottom|secondary/i
/** Karaoke timing tags. */
const KARAOKE_TAG = /\{[^}]*\\(?:k|kf|ko|K)\d/
/** Typesetting tags that place text on the picture. */
const PLACEMENT_TAG = /\{[^}]*\\(?:pos|move|org|clip|iclip)\(/

/** ISO 639-2 codes of media tracks that differ from their ISO 639-1 code. */
const TWO_LETTER: Record<string, string> = {
  jpn: 'ja',
  jap: 'ja',
  eng: 'en',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  spa: 'es',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  por: 'pt',
  ita: 'it',
  rus: 'ru',
  ara: 'ar',
  tha: 'th',
  vie: 'vi',
  ind: 'id',
}

/**
 * Normalizes a track language code. Recognition and the WATCH block use two-letter codes.
 * A track without a language is Japanese when its text has kana.
 *
 * @example
 * languageCodeOf('jpn')
 * // => 'ja'
 */
export function languageCodeOf(code: string | undefined, text?: string): string | undefined {
  const value = code?.trim().toLowerCase()
  if (value && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) && value !== 'und' && value !== 'mul')
    return TWO_LETTER[value] ?? value
  return text && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 'ja' : undefined
}

/**
 * Normalizes one subtitle text. Line breaks of multi-line dialogue stay. Spaces in a line collapse.
 *
 * @example
 * subtitleTextOf('  First line\r\n  Second   line ')
 * // => 'First line\nSecond line'
 */
export function subtitleTextOf(input: string): string {
  const lines = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\p{Cc}/gu, '').replace(INVISIBLE_MARKS, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_SUBTITLE_LINES)
  return lines.join('\n').slice(0, MAX_SUBTITLE_CHARS)
}

/**
 * Visible text of one ASS event, the same way mpv strips it: `\N` and `\n` break lines, `\h` is a space, override
 * blocks go, and drawing commands between `\p1` and `\p0` are not text.
 */
function visibleText(text: string): string {
  let out = ''
  let drawing = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{') {
      const end = text.indexOf('}', i)
      // A '{' without a closing '}' is visible text.
      if (end < 0) {
        out += text.slice(i)
        break
      }
      const block = text.slice(i + 1, end)
      for (const match of block.matchAll(/\\p(\d+)/g))
        drawing = Number(match[1]) > 0
      i = end
      continue
    }
    if (char === '\\' && (text[i + 1] === 'N' || text[i + 1] === 'n')) {
      out += '\n'
      i++
      continue
    }
    if (char === '\\' && text[i + 1] === 'h') {
      out += ' '
      i++
      continue
    }
    if (!drawing)
      out += char
  }
  return subtitleTextOf(out)
}

function kindOf(text: string, labels?: { style: string, name: string, effect: string }): CueKind {
  const label = labels ? `${labels.style} ${labels.name} ${labels.effect}` : ''
  if (SONG_LABEL.test(label) || KARAOKE_TAG.test(text))
    return 'song'
  if (SIGN_LABEL.test(label))
    return 'sign'
  if (labels && DIALOGUE_STYLE.test(labels.style))
    return 'dialogue'
  return PLACEMENT_TAG.test(text) ? 'sign' : 'dialogue'
}

/**
 * Splits the ASS form of a current subtitle into classified lines.
 *
 * - `ass-full`: mpv `sub-text/ass-full`, one `Dialogue:` line per event with style, name, and effect.
 * - `ass`: mpv `sub-text-ass` or `sub-text/ass`, the text field of each event on its own line.
 *
 * Style names decide first, override tags second. The result is a guess from untrusted fansub labels.
 * Identical lines from stacked layers appear once.
 *
 * @example
 * assLinesOf('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0000,0000,0000,,Hello\\NThere', 'ass-full')
 * // => [{ kind: 'dialogue', text: 'Hello\nThere' }]
 */
export function assLinesOf(input: string, form: 'ass-full' | 'ass'): SubtitleLine[] {
  const lines: SubtitleLine[] = []
  for (const raw of input.replace(/\r\n?/g, '\n').split('\n')) {
    let text = raw
    let labels: { style: string, name: string, effect: string } | undefined
    if (form === 'ass-full') {
      // Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, then Text. Text can hold commas.
      if (!raw.startsWith('Dialogue:'))
        continue
      const fields = raw.slice('Dialogue:'.length).split(',')
      if (fields.length < 10)
        continue
      labels = { style: fields[3].trim(), name: fields[4].trim(), effect: fields[8].trim() }
      text = fields.slice(9).join(',')
    }
    const visible = visibleText(text)
    if (!visible || lines.some(line => line.text === visible))
      continue
    lines.push({ kind: kindOf(text, labels), text: visible })
  }
  return lines
}

/**
 * The dialogue part of the current subtitle: dialogue lines as they are and sung lines marked with `♪`.
 * Signs are not speech, so they never become dialogue. Returns an empty string when nothing is spoken or sung.
 *
 * @example
 * dialogueOf([{ kind: 'sign', text: 'Bakery' }, { kind: 'dialogue', text: 'Let us go.' }])
 * // => 'Let us go.'
 */
export function dialogueOf(lines: readonly SubtitleLine[]): string {
  return subtitleTextOf(lines
    .filter(line => line.kind !== 'sign')
    .map(line => line.kind === 'song' ? line.text.split('\n').map(part => `♪ ${part}`).join('\n') : line.text)
    .join('\n'))
}

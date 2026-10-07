import type { IncomingMessage } from 'node:http'

import { Buffer, File } from 'node:buffer'

/** The accepted upload contains one audio file and only supported transcription options. */
export interface TranscriptionUpload {
  /** The `speech-recognition` alias that the client named. */
  alias: string
  file: Blob
  filename: string
  sourceFilename: string
  responseFormat: 'json' | 'text' | 'verbose_json'
  language?: string
  prompt?: string
  temperature?: string
}

/** Carries public request errors without exposing the multipart bytes. */
export class AudioRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/**
 * Reads a bounded multipart upload in memory. Abort releases the retained chunks and stops the request reader.
 * The `model` field must name one of `aliases`. It selects a configured chain and never a provider model.
 */
export async function readUpload(req: IncomingMessage, limit: number, signal: AbortSignal, aliases: ReadonlySet<string>): Promise<TranscriptionUpload> {
  const contentType = req.headers['content-type'] ?? ''
  const boundary = /^multipart\/form-data\s*;\s*boundary=(?:"([\w'()+,./:=?-]{1,70})"|([\w'()+,./:=?-]{1,70}))\s*$/i.exec(contentType)
  if (!boundary)
    throw new AudioRequestError(400, 'invalid_multipart', 'A multipart audio file is required.')
  if (Number(req.headers['content-length']) > limit)
    throw new AudioRequestError(413, 'audio_too_large', 'The audio upload is too large.')
  const raw = await readBytes(req, limit, signal)
  signal.throwIfAborted()
  // Only framed delimiters split binary audio. Each part has bounded headers and one supported disposition shape.
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  if (!raw.subarray(0, marker.length).equals(marker))
    throw new AudioRequestError(400, 'invalid_multipart', 'The audio upload is malformed.')
  const delimiter = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`)
  let offset = marker.length
  let parts = 0
  const form = new FormData()
  const names = new Set<string>()
  while (true) {
    if (raw.subarray(offset, offset + 2).toString() === '--')
      break
    if (++parts > 6)
      throw new AudioRequestError(400, 'invalid_multipart', 'The upload contains too many fields.')
    const headerEnd = raw.indexOf('\r\n\r\n', offset)
    if (headerEnd < 0 || headerEnd - offset > 4096)
      throw new AudioRequestError(400, 'invalid_multipart', 'The upload contains invalid part headers.')
    const next = findDelimiter(raw, delimiter, headerEnd + 4)
    if (next < 0)
      throw new AudioRequestError(400, 'invalid_multipart', 'The audio upload is malformed.')
    if (raw.subarray(offset, offset + 2).toString() !== '\r\n')
      throw new AudioRequestError(400, 'invalid_multipart', 'The upload contains invalid part headers.')
    const headers = new Map<string, string>()
    for (const line of raw.subarray(offset + 2, headerEnd).toString('utf8').split('\r\n')) {
      const match = /^([a-z-]+):([^\r\n]*)$/i.exec(line)
      const name = match?.[1].toLowerCase()
      if (!match || !name || !['content-disposition', 'content-type'].includes(name) || headers.has(name))
        throw new AudioRequestError(400, 'invalid_multipart', 'The upload contains invalid part headers.')
      headers.set(name, match[2].trim())
    }
    const disposition = /^form-data;\s*name="([^"\r\n]{1,64})"(?:;\s*filename="([^"\r\n]{0,512})")?$/i.exec(headers.get('content-disposition') ?? '')
    const name = disposition?.[1]
    if (!disposition || !name || !['file', 'model', 'language', 'prompt', 'temperature', 'response_format'].includes(name) || names.has(name))
      throw new AudioRequestError(400, 'invalid_audio_option', 'The upload contains unsupported or duplicate fields.')
    names.add(name)
    const bytes = raw.subarray(headerEnd + 4, next)
    if (disposition[2] !== undefined) {
      if (name !== 'file')
        throw new AudioRequestError(400, 'invalid_audio_option', 'Transcription options must be text fields.')
      form.set(name, new File([new Uint8Array(bytes)], disposition[2], { type: headers.get('content-type') ?? 'application/octet-stream' }))
    }
    else {
      if (bytes.byteLength > 4096)
        throw new AudioRequestError(400, 'invalid_audio_option', 'A transcription option is too long.')
      form.set(name, bytes.toString('utf8'))
    }
    offset = next + delimiter.length
  }
  signal.throwIfAborted()
  const alias = form.get('model')
  if (typeof alias !== 'string' || !aliases.has(alias))
    throw new AudioRequestError(404, 'model_not_found', 'Use a configured speech-recognition alias, for example companion-stt.')
  const file = form.get('file')
  if (!file || typeof file === 'string' || file.size === 0)
    throw new AudioRequestError(400, 'audio_file_required', 'An audio file is required. URL input is not supported.')
  const responseFormat = stringField(form, 'response_format') ?? 'json'
  if (!['json', 'text', 'verbose_json'].includes(responseFormat))
    throw new AudioRequestError(400, 'invalid_response_format', 'Use json, text, or verbose_json.')
  const language = stringField(form, 'language')
  if (language !== undefined && !/^[a-z]{2}$/.test(language))
    throw new AudioRequestError(400, 'invalid_language', 'Use an ISO 639-1 language code.')
  const temperature = stringField(form, 'temperature')
  if (temperature !== undefined && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(temperature) || !Number.isFinite(Number(temperature))))
    throw new AudioRequestError(400, 'invalid_temperature', 'The temperature must be between 0 and 1.')
  const prompt = stringField(form, 'prompt')
  if (prompt !== undefined && prompt.length > 2048)
    throw new AudioRequestError(400, 'invalid_prompt', 'The transcription prompt is too long.')
  const filename = safeFilename(file.name, file.type)
  const mimeTypes: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', mp4: 'video/mp4', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' }
  return {
    alias,
    file: new Blob([file], { type: mimeTypes[filename.slice(6)] }),
    filename,
    sourceFilename: file.name,
    responseFormat: responseFormat as TranscriptionUpload['responseFormat'],
    language,
    prompt: prompt?.replace(/[\u0000-\u0008\v\f\u000E-\u001F\u007F]/g, ' '),
    temperature,
  }
}

function findDelimiter(raw: Buffer, delimiter: Buffer, start: number): number {
  let index = raw.indexOf(delimiter, start)
  while (index >= 0) {
    const after = index + delimiter.length
    const nextPart = raw[after] === 0x0D && raw[after + 1] === 0x0A
    // A closing marker must end the body or precede CRLF. Other suffixes remain file bytes.
    const closing = raw[after] === 0x2D && raw[after + 1] === 0x2D
      && (after + 2 === raw.length || (raw[after + 2] === 0x0D && raw[after + 3] === 0x0A))
    if (nextPart || closing)
      return index
    index = raw.indexOf(delimiter, after)
  }
  return -1
}

function stringField(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  if (value === null)
    return undefined
  if (typeof value !== 'string')
    throw new AudioRequestError(400, 'invalid_audio_option', 'Transcription options must be text fields.')
  return value
}

/**
 * Removes all user text from the provider filename while preserving the audio format.
 * @example
 * safeFilename('../../private.webm', 'audio/webm')
 * // => 'audio.webm'
 */
function safeFilename(name: string, mime: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()
  if (extension && ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'].includes(extension))
    return `audio.${extension}`
  const formats: Record<string, string> = { 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'mp4' }
  const fromMime = formats[mime.split(';')[0].trim().toLowerCase()]
  if (!fromMime)
    throw new AudioRequestError(400, 'unsupported_audio_format', 'The audio format is not supported.')
  return `audio.${fromMime}`
}

function readBytes(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = []
    let size = 0
    function cleanup() {
      req.off('data', data)
      req.off('end', end)
      req.off('error', fail)
      req.off('aborted', abort)
      signal.removeEventListener('abort', abort)
    }
    function fail(error: unknown) {
      cleanup()
      chunks = []
      req.pause()
      reject(error)
    }
    function abort() {
      fail(signal.reason ?? new Error('Audio upload aborted.'))
    }
    function data(chunk: Buffer) {
      size += chunk.byteLength
      if (size > limit)
        return fail(new AudioRequestError(413, 'audio_too_large', 'The audio upload is too large.'))
      chunks.push(chunk)
    }
    function end() {
      cleanup()
      const bytes = Buffer.concat(chunks, size)
      chunks = []
      resolve(bytes)
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', fail)
    req.once('aborted', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
  })
}

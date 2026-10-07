import type { TranscriptionUpload } from '../audio/multipart'

/** The adapter accepts only a configured target. It never resolves a URL from client fields. */
export interface TranscriptionTarget {
  url: URL
  model: string
  apiKey?: string
}

/** Builds one OpenAI-compatible multipart request. Redirects are rejected to keep audio and keys on the trusted target. */
export function sendTranscription(target: TranscriptionTarget, upload: TranscriptionUpload, signal: AbortSignal, transport: typeof fetch = fetch): Promise<Response> {
  const body = new FormData()
  body.set('file', upload.file, upload.filename)
  body.set('model', target.model)
  body.set('response_format', upload.responseFormat)
  if (upload.language !== undefined)
    body.set('language', upload.language)
  if (upload.prompt !== undefined)
    body.set('prompt', upload.prompt)
  if (upload.temperature !== undefined)
    body.set('temperature', upload.temperature)
  return transport(target.url, {
    method: 'POST',
    headers: target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {},
    body,
    signal,
    redirect: 'error',
  })
}

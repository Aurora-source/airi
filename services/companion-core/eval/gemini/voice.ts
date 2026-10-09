import { chunkTtsInput } from '@proj-airi/pipelines-audio'

import { spokenText } from './protocol'

/**
 * Replays measured text arrival times through the existing upstream word chunker.
 * The reader tracks virtual arrival time, including the chunker's lookahead.
 * ACT removal uses the benchmark's strict marker gate. Audio services and VoiceController do not run.
 */
export async function replayVoiceText(chunks: { text: string, atMs: number }[], totalMs: number): Promise<{ firstChunkAtMs?: number, chunks: string[], parsingCpuMs: number }> {
  const started = performance.now()
  const pieces: { bytes: Uint8Array, atMs: number }[] = []
  let text = ''
  let emitted = ''
  for (const part of chunks) {
    text += part.text
    // A trailing '<' can become a control opener in the next fragment. Withhold it until the prefix is resolved.
    const spoken = spokenText(text.endsWith('<') ? text.slice(0, -1) : text)
    const additional = spoken.slice(emitted.length)
    emitted = spoken
    if (additional)
      pieces.push({ bytes: new TextEncoder().encode(additional), atMs: part.atMs })
  }
  let index = 0
  let atMs = 0
  const reader = { read: async () => {
    const next = pieces[index++]
    atMs = next?.atMs ?? totalMs
    return next ? { value: next.bytes, done: false as const } : { value: undefined, done: true as const }
  } }
  const output: string[] = []
  let firstChunkAtMs: number | undefined
  for await (const chunk of chunkTtsInput(reader)) {
    if (!chunk.text.trim())
      continue
    firstChunkAtMs ??= atMs
    output.push(chunk.text.trim())
  }
  return { firstChunkAtMs, chunks: output, parsingCpuMs: performance.now() - started }
}

# Architecture decisions

## 1. Reuse the existing Gateway

The harness calls Gemini directly and starts the existing Companion Core Gateway with isolated synthetic configuration.
It does not create another provider abstraction or alter live routing.

## 2. Fail closed on billing uncertainty

Each inference reserves its conservative maximum cost before dispatch.
The durable ledger retains reservations across interruption and rejects further inference when usage is ambiguous.
Retries require separate reservations. Live cancellation ends a campaign when final usage is unavailable.

## 3. Separate measurements from claims

Provider text timings cannot establish microphone-to-speaker latency.
Small samples receive descriptive percentiles and explicit uncertainty.
Human character review remains separate from mechanical compatibility checks.

## 4. Preserve production behavior

No production model choice, credential, billing setting, visual implementation, or Director integration changes.
Only measured bottlenecks qualify for runtime optimization.

## 5. Distinguish native tools from stage markers

The existing persona contract describes stage CALL tokens. Native API tools require a separate explicit instruction.
The harness uses the existing function schemas and preserves Gemini tool indices and thought signatures.
It records automatic selection failures separately from forced probes.

## 6. Keep thinking settings at the client boundary

Core model configuration has no per-model thinking override. Its style reminder is an existing configuration feature.
The example uses explicit Flash and Lite aliases with separate client settings.
Automatic mixed-model fallback requires additional integration validation. It was not silently enabled during the campaign.

## 7. Keep monthly assumptions explicit

Forecasts use measured response tokens and bounded chat, tool, vision, reaction, and reasoning scenarios.
They assume no cache discount. Local Mura TTS has no metered API cost.
Groq STT remains separate from Gemini credits. Promotional eligibility and future Flash pricing remain explicit.

## 8. Report the provider bottleneck

Measured Gateway preparation and selection take milliseconds. Provider/network response time dominates short-turn latency.
The reminder improves short ACT delivery, with no measured speed gain and incomplete multi-turn reliability.
No speculative production caching, parallelism, retry change, or voice architecture change was added.

import type { ExternalVisualActivity, IdleIntensity, VisualActivity, VisualBehavior, VisualFrame, VisualModelAdapter, VisualMotionHandle, VisualRequestResult } from './contracts'

import { idleProfiles, visualBehaviorCatalog } from './catalog'

const axes = ['headPitch', 'headYaw', 'headRoll', 'bodyPitch', 'bodyRoll', 'gazeX', 'gazeY', 'breath'] as const
const emptyFrame = (): VisualFrame => ({ headPitch: 0, headYaw: 0, headRoll: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0, breath: 0, expressionWeight: 0 })
const smooth = (t: number) => t * t * (3 - 2 * t)
/**
 * Call update from the existing render loop. No timers or listeners are installed.
 * One model and one behavior are owned at a time. Activity and intensity are host choices.
 * attach transfers adapter ownership. dispose releases adapters, but never disposes avatar assets.
 */
export function createVisualBehaviorController(options: {
  adapter?: VisualModelAdapter
  now?: () => number
  random?: () => number
  catalog?: readonly VisualBehavior[]
} = {}) {
  const clock = options.now ?? (() => performance.now())
  const random = options.random ?? Math.random
  const catalog = options.catalog ?? visualBehaviorCatalog
  const frame = emptyFrame()
  const history: string[] = []
  const cooldowns = new Map<string, number>()
  let adapter = options.adapter
  let now = clock()
  let enabled = false
  let disposed = false
  let intensity: IdleIntensity = 'normal'
  let activity: VisualActivity = 'idle'
  let external: ExternalVisualActivity = { speaking: false, act: false, modelMotion: false, userControl: false }
  let active: {
    behavior: VisualBehavior
    start: number
    duration: number
    priority: number
    from: VisualFrame
    motion?: VisualMotionHandle
  } | undefined
  let recovery: {
    start: number
    from: VisualFrame
  } | undefined
  let neutralUntil = now
  let idleSince = now
  let expressionAfter = now
  let longAfter = now + 180000
  let nextIdle = Infinity
  let nextNod = Infinity
  // Sample once per scheduling decision. User-supplied PRNGs retain deterministic state.
  function unit() {
    return sampleValue(random())
  }
  function sampleValue(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0
  }
  function syncTime(value = clock()) {
    if (Number.isFinite(value))
      now = Math.max(now, value)
  }
  function blocked() {
    return external.speaking || external.act || external.modelMotion || external.userControl
  }
  function schedule() {
    const range = idleProfiles[intensity].interval
    nextIdle = Number.isFinite(range[0]) ? Math.max(neutralUntil, now) + range[0] + unit() * (range[1] - range[0]) : Infinity
  }
  function supports(behavior: VisualBehavior) {
    const caps = adapter?.capabilities
    if (!caps)
      return false
    return Boolean((behavior.expression && caps.expressions.has(behavior.expression))
      || (adapter?.playMotion && behavior.motionRole && caps.motions.some(m => m.role === behavior.motionRole))
      || (behavior.pose && axes.some(axis => caps.axes.has(axis) && behavior.pose?.[axis])))
  }
  function clearFrame() {
    for (const axis of axes)
      frame[axis] = 0
    frame.expression = undefined
    frame.expressionWeight = 0
  }
  function interrupt(hard: boolean) {
    active?.motion?.stop()
    active = undefined
    if (hard) {
      recovery = undefined
      adapter?.release()
      clearFrame()
    }
    else {
      recovery = { start: now, from: { ...frame } }
    }
    neutralUntil = now + idleProfiles[intensity].neutralMs
    schedule()
  }
  function begin(behavior: VisualBehavior, priority: number): VisualRequestResult {
    if (disposed)
      return 'disposed'
    if (blocked() || (activity === 'listening' && priority < 60))
      return 'blocked'
    if ((cooldowns.get(behavior.id) ?? -Infinity) > now)
      return 'cooldown'
    if (!supports(behavior))
      return 'unsupported'
    const from = { ...frame }
    active?.motion?.stop()
    adapter?.release()
    recovery = undefined
    const motion = adapter?.capabilities.motions.find(m => m.role && m.role === behavior.motionRole)
    let handle: VisualMotionHandle | undefined
    try {
      handle = motion ? adapter?.playMotion?.(motion, priority <= 20 ? 'idle' : 'explicit') : undefined
    }
    catch {
      // An optional native motion failure keeps the safe procedural fallback available.
    }
    active = { behavior, priority, start: now, duration: handle && motion ? Math.min(15000, motion.durationMs) : behavior.durationMs, from, motion: handle }
    cooldowns.set(behavior.id, now + behavior.cooldownMs)
    if (priority <= 20) {
      history.push(behavior.id)
      if (history.length > 3)
        history.shift()
    }
    if (behavior.expression)
      expressionAfter = now + 120000
    if (behavior.category === 'long')
      longAfter = now + 180000
    return 'started'
  }
  function request(id: string, priority = 40): VisualRequestResult {
    syncTime()
    const behavior = catalog.find(b => b.id === id)
    return behavior ? begin(behavior, priority) : disposed ? 'disposed' : 'unknown'
  }
  function chooseIdle() {
    const allowLong = now >= longAfter && now - idleSince >= 120000 && unit() < idleProfiles[intensity].longProbability
    const candidates = catalog.filter(b => b.idle && (allowLong ? b.category === 'long' : b.category !== 'long')
      && !history.includes(b.id) && (cooldowns.get(b.id) ?? -Infinity) <= now
      && (!b.expression || now >= expressionAfter) && supports(b))
    const total = candidates.reduce((sum, b) => sum + b.weight, 0)
    let target = unit() * total
    for (const behavior of candidates) {
      target -= behavior.weight
      if (target < 0) {
        begin(behavior, behavior.category === 'long' ? 20 : 10)
        break
      }
    }
    schedule()
  }
  function micro() {
    if (!adapter || intensity === 'still')
      return
    const caps = adapter.capabilities
    const amount = idleProfiles[intensity].amplitude
    // Native gaze, breath and pose keep their channels. The added drift stays below half a degree.
    if (!caps.nativeMicro.has('pose')) {
      frame.headYaw = Math.sin(now / 8700) * 0.006 * amount
      frame.headRoll = Math.sin(now / 13700) * 0.004 * amount
      frame.bodyRoll = Math.sin(now / 16900) * 0.002 * amount
    }
    if (!caps.nativeMicro.has('gaze'))
      frame.gazeX = Math.sin(now / 11300) * 0.045 * amount
    if (!caps.nativeMicro.has('breath'))
      frame.breath = (Math.sin(now / 650) + 1) * 0.025 * amount
  }
  return {
    start() {
      if (disposed)
        return
      syncTime()
      enabled = true
      idleSince = now
      schedule()
    },
    stop() {
      if (disposed)
        return
      syncTime()
      enabled = false
      interrupt(true)
    },
    playVisualBehavior: request,
    setIdleIntensity(value: IdleIntensity) {
      if (disposed || intensity === value)
        return
      syncTime()
      intensity = value
      if (active && active.priority <= 20)
        interrupt(false)
      if (value === 'still' && !active)
        interrupt(true)
      schedule()
    },
    setVisualActivity(value: VisualActivity) {
      if (disposed || activity === value)
        return
      syncTime()
      activity = value
      idleSince = now
      interrupt(false)
      if (value === 'listening') {
        request('listening', 60)
        nextNod = now + 20000 + unit() * 15000
      }
      else if (value === 'thinking' || value === 'waiting') {
        request(value, 40)
      }
      else {
        nextNod = Infinity
      }
    },
    setExternalActivity(value: Readonly<ExternalVisualActivity>) {
      if (disposed)
        return
      if (external.speaking === value.speaking && external.act === value.act && external.modelMotion === value.modelMotion && external.userControl === value.userControl)
        return
      syncTime()
      const wasBlocked = blocked()
      external = { ...value }
      if (blocked()) {
        interrupt(true)
      }
      else if (wasBlocked) {
        idleSince = now
        neutralUntil = now + idleProfiles[intensity].neutralMs
        schedule()
      }
    },
    cancelBehavior() {
      if (!disposed) {
        syncTime()
        interrupt(false)
      }
    },
    returnToNeutral() {
      if (!disposed) {
        syncTime()
        interrupt(false)
      }
    },
    attach(next?: VisualModelAdapter) {
      if (disposed) {
        next?.dispose()
        return
      }
      if (adapter === next)
        return
      syncTime()
      interrupt(true)
      adapter?.dispose()
      adapter = next
      history.length = 0
      cooldowns.clear()
      expressionAfter = now
      longAfter = now + 180000
      idleSince = now
      schedule()
    },
    update(time = clock()) {
      if (disposed)
        return
      syncTime(time)
      if (!adapter || blocked())
        return
      if (active && now - active.start >= active.duration) {
        interrupt(true)
        neutralUntil = now + idleProfiles[intensity].neutralMs
        schedule()
      }
      clearFrame()
      if (recovery) {
        const progress = Math.min(1, (now - recovery.start) / 450)
        const weight = 1 - smooth(progress)
        for (const axis of axes)
          frame[axis] = recovery.from[axis] * weight
        frame.expression = recovery.from.expression
        frame.expressionWeight = recovery.from.expressionWeight * weight
        adapter.apply(frame)
        if (progress >= 1) {
          recovery = undefined
          adapter.release()
        }
        return
      }
      if (!active && enabled && now >= neutralUntil) {
        if (activity === 'listening' && now >= nextNod) {
          request('nod', 60)
          nextNod = now + 20000 + unit() * 20000
        }
        if ((activity === 'idle' || activity === 'watching') && now >= nextIdle)
          chooseIdle()
      }
      if (active) {
        const { behavior, start, duration, priority, from } = active
        const t = Math.min(1, (now - start) / duration)
        const envelope = smooth(Math.min(1, t * 5)) * smooth(Math.min(1, (1 - t) * 4))
        const oscillation = behavior.oscillations ? Math.sin(t * Math.PI * behavior.oscillations) : 1
        const amplitude = priority <= 20 ? idleProfiles[intensity].amplitude : 1
        const onset = smooth(Math.min(1, (now - start) / 350))
        for (const axis of axes)
          frame[axis] = from[axis] * (1 - onset) + (active.motion ? 0 : behavior.pose?.[axis] ?? 0) * envelope * oscillation * amplitude * onset
        if (behavior.expression && adapter.capabilities.expressions.has(behavior.expression)) {
          frame.expression = behavior.expression
          frame.expressionWeight = Math.min(0.45, (behavior.expressionWeight ?? 0.2) * envelope * amplitude)
        }
      }
      else if (enabled && intensity !== 'still' && now >= neutralUntil) {
        micro()
      }
      else {
        return
      }
      for (const axis of axes) {
        const limit = axis.startsWith('gaze') ? 0.4 : axis === 'breath' ? 0.15 : axis.startsWith('body') ? 0.025 : 0.12
        frame[axis] = adapter.capabilities.axes.has(axis) ? Math.max(-limit, Math.min(limit, frame[axis])) : 0
      }
      adapter.apply(frame)
    },
    snapshot() {
      return { modelId: adapter?.capabilities.modelId, enabled, intensity, activity, blocked: blocked(), behavior: active?.behavior.id, priority: active?.priority, nextIdleAt: nextIdle }
    },
    dispose() {
      if (disposed)
        return
      interrupt(true)
      adapter?.dispose()
      adapter = undefined
      cooldowns.clear()
      history.length = 0
      disposed = true
    },
  }
}

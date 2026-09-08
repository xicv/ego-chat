// This deadline concerns repeated observations of an inactive response, not the
// duration of active reasoning. Expiry preserves the sent turn for read-only
// recovery; it never grants Send, cancellation, or conversation-change authority.
export function browserCaptureWaitPolicy(pending, nowMs = Date.now()) {
  if (pending?.reason !== "response_not_terminal" || pending.generationRunning !== false) {
    return { delayMs: 250, inactiveForMs: 0, pause: false }
  }
  const startedAt = Date.parse(pending.observedAt)
  const inactiveForMs = Number.isFinite(startedAt) && Number.isFinite(nowMs)
    ? Math.max(0, nowMs - startedAt)
    : 0
  const delayMs = inactiveForMs >= 5 * 60_000 ? 30_000
    : inactiveForMs >= 60_000 ? 15_000
      : inactiveForMs >= 10_000 ? 5_000 : 2_000
  return { delayMs, inactiveForMs, pause: inactiveForMs >= 30 * 60_000 }
}

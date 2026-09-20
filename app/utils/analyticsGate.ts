export type AnalyticsInitializer = () => void | (() => void)

let activeCleanup: (() => void) | null = null
let analyticsActive = false

/**
 * Future analytics providers must enter through this gate. No provider is
 * registered today, so this function is intentionally not called by the app.
 */
export function initializeAnalyticsIfAllowed(analyticsAllowed: boolean, initializer: AnalyticsInitializer): boolean {
  if (!analyticsAllowed || analyticsActive) return false
  activeCleanup = initializer() || null
  analyticsActive = true
  return true
}

export function stopOptionalAnalytics(): void {
  activeCleanup?.()
  activeCleanup = null
  analyticsActive = false
}

export function resetAnalyticsGateForTests(): void {
  stopOptionalAnalytics()
}

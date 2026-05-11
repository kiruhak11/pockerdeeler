const DEFAULT_QUICK_BET_STEPS = [50, 100, 500]

export function parseQuickBetSteps(value: string): number[] {
  const normalized = value
    .split(/[\s,;]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.trunc(item))
    .filter((item) => item > 0 && item <= 1_000_000)

  const unique = [...new Set(normalized)]
  return unique.length ? unique.slice(0, 10) : [...DEFAULT_QUICK_BET_STEPS]
}

export function formatQuickBetSteps(steps: number[] | undefined): string {
  if (!Array.isArray(steps) || !steps.length) {
    return DEFAULT_QUICK_BET_STEPS.join(', ')
  }

  return steps.join(', ')
}

export function defaultQuickBetSteps(): number[] {
  return [...DEFAULT_QUICK_BET_STEPS]
}

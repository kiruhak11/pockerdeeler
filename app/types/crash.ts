export type CrashPhase = 'betting' | 'flying' | 'crashed'

export interface CrashRoundState {
  id: string
  phase: CrashPhase
  multiplier: number
  startsInMs: number
  crashAt: number | null
  seedHash: string
}

export interface CrashBetState {
  stake: number
  cashedAt: number | null
  payout: number
  autoCashout: number | null
}

export interface CrashHistoryItem {
  id: string
  crashAt: number
  seedHash: string
}

export interface CrashState {
  balance: number
  round: CrashRoundState
  bet: CrashBetState | null
  history: CrashHistoryItem[]
  stats: { players: number; totalStake: number }
  currentBets: Array<{ id: string; username: string; stake: number; cashedAt: number | null; payout: number; autoCashout: number | null }>
  economy: { minesBank: number; rocketBank: number; jackpot: number; participants: Array<{ userId: string; username: string; lost: number; chance: number }> }
}

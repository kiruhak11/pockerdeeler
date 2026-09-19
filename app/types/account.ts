export interface AccountUser {
  id: string
  username: string
  phone: string | null
  phoneVerified: boolean
  role: 'USER' | 'ADMIN' | 'SUPERADMIN'
  mustChangePassword: boolean
  /** Free chips. Table stacks and prediction points are tracked separately. */
  balance: number
  predictionRating: number
  tableRating: number
  tableHandsPlayed: number
  tableHandsWon: number
  tableCurrentStreak: number
  tableBestStreak: number
  predictionCount: number
  predictionWins: number
  predictionSplitWins: number
  selectedAchievementCode: string | null
  premiumType: 'FREE' | 'PREMIUM'
  premiumUntil: string | null
  walletVersion?: number
  nextDailyBonusAt: string | null
}

export type PhonePurpose = 'register' | 'recover' | 'link'

export interface PhoneVerification {
  id: string
  phone: string
  status: string
  callPhone: string | null
  expiresAt: string
}

export interface RewardState {
  enabled: boolean
  amount: number
  seconds: 10
  elite: boolean
  requiresViewing: boolean
  eliteAttempt: boolean
  nextAvailableAt: string | null
  available: boolean
  reason?: string
  attempt: {
    id: string
    status: string
    readyAt: string
    expiresAt: string
    amount: number
  } | null
}

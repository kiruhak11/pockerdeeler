export type PremiumPlan = 'LITE' | 'PRO' | 'ELITE'
export type PremiumStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED'
export type PremiumFeature =
  | 'PREMIUM_BADGE' | 'PREMIUM_FRAMES' | 'ADDITIONAL_THEMES' | 'EXTENDED_HISTORY' | 'BASIC_STATS'
  | 'ADVANCED_ANALYTICS' | 'BALANCE_CHART' | 'EXTENDED_POKER_STATS' | 'EXTENDED_MINIGAME_STATS'
  | 'PREMIUM_ACHIEVEMENTS' | 'VISUAL_SETTINGS'
  | 'POKER_HANDS_GUIDE' | 'ROOM_CHAT'
  | 'ELITE_BADGE' | 'PREMIUM_NAME_COLOR' | 'ANIMATED_PROFILE_FRAME' | 'PROFILE_PRESETS'
  | 'EXTENDED_PROFILE_STYLE' | 'LEADERBOARD_PREMIUM_FILTER'

export interface PremiumAccess {
  active: boolean
  plan: PremiumPlan | null
  status: PremiumStatus | 'NONE'
  startedAt: string | null
  expiresAt: string | null
  features: PremiumFeature[]
  achievements: { code: string; title: string; description: string; icon: string }[]
}

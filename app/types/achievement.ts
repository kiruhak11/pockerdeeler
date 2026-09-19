export interface AchievementView {
  code: string
  title: string
  description: string
  icon: string
  rarity: string
  ratingReward: number
  moneyReward: number
  unlocked: boolean
  unlockedAt: string | null
  seasonal?: boolean
  seasonNumber?: number
  rewardId?: string
  category?: string
  place?: number | null
}

export interface AchievementResponse {
  selectedCode: string | null
  achievements: AchievementView[]
}

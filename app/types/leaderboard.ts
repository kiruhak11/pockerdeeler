export type LeaderboardSort = 'balance' | 'rating' | 'wins' | 'achievements' | 'streak' | 'season'

export interface LeaderboardEntry {
  rank: number
  userId?: string
  username: string
  value?: number
  balance?: number
  predictionRating?: number
  tableRating?: number
  selectedAchievementIcon?: string | null
  handsPlayed?: number
  predictions?: number
  predictionWins?: number
  wins?: number
  splitWins?: number
  successPercent?: number
  streak?: number
  bestStreak?: number
  achievements?: number
  achievementsList?: { id: string; title: string; description: string; icon: string; rarity: string; unlockedAt: string | null }[]
}

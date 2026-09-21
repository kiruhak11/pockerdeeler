export type PublicLeaderboardAchievement = {
  id: string
  title: string
  description: string
  icon: string
  rarity: string
  unlockedAt: string | null
  seasonal?: boolean
  seasonNumber?: number
}

export type PublicLeaderboardInput = {
  userId: string
  username: string
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
  selectedAchievementIcon: string | null
  achievements: number
  achievementsList: PublicLeaderboardAchievement[]
}

/**
 * Leaderboard visibility is the user's explicit switch for publishing these
 * aggregate game metrics. Keep the row complete so the UI does not silently
 * degrade to nickname + rating when a separate distribution consent is absent.
 */
export function toPublicLeaderboardRow(input: PublicLeaderboardInput) {
  return {
    userId: input.userId,
    username: input.username,
    balance: input.balance,
    predictionRating: input.predictionRating,
    tableRating: input.tableRating,
    handsPlayed: input.tableHandsPlayed,
    predictions: input.predictionCount,
    predictionWins: input.predictionWins,
    wins: input.tableHandsWon,
    splitWins: input.predictionSplitWins,
    successPercent: input.predictionCount ? Math.round(input.predictionWins * 100 / input.predictionCount) : 0,
    streak: input.tableCurrentStreak,
    bestStreak: input.tableBestStreak,
    selectedAchievementIcon: input.selectedAchievementIcon,
    achievements: input.achievements,
    achievementsList: input.achievementsList
  }
}

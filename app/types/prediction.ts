import type { Street } from '../utils/bettingRounds'

export type RoomMemberState = 'pending' | 'playing' | 'predicting' | 'pending_reentry' | 'spectating' | 'left'
export type PredictionMarketStatus = 'scheduled' | 'open' | 'locked' | 'settled' | 'void'
export type PredictionBetStatus = 'open' | 'won' | 'lost' | 'refunded'

export interface RoomMemberSummary {
  id: string
  displayName: string
  state: RoomMemberState
  initialBuyIn: number | null
  requestedBuyIn: number | null
  predictionGrant: number
  eliminatedAt?: string
  reentryCount: number
  playerId?: string
  userId?: string
  isConnected: boolean
}

export interface PredictionQuoteView {
  playerId: string
  playerName: string
  seat: number
  modelScore: number
  odds: number
  realStake: number
  virtualStake: number
  reasonCodes: string[]
  available: boolean
}

export interface PredictionBetView {
  id: string
  marketId: string
  candidatePlayerId: string
  candidateName: string
  memberName?: string
  stake: number
  status: PredictionBetStatus
  grossPayout: number
  netProfit: number
  riskPercent: number
  ratingDelta: number | null
  quoteRevision: number
  acceptedOdds: number | null
  potentialPayout: number | null
  placedStreet: Street | null
  createdAt: string
  settledAt?: string
}

export interface PredictionMarketView {
  id: string
  handId: string
  handNumber: number
  status: PredictionMarketStatus
  revision: number
  pricingMode: 'pari_mutuel' | 'fixed_odds'
  street: Street
  acceptingBets: boolean
  question: string
  totalPool: number
  openedAt?: string
  lockDueAt?: string
  lockedAt?: string
  settledAt?: string
  voidReason?: string
  quotes: PredictionQuoteView[]
}

export interface ReentryRequestView {
  id: string
  memberId: string
  playerId: string
  memberName: string
  amount: number
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  reviewedAt?: string
}

export interface PredictionViewerState {
  roomId: string
  roomRevision: number
  eligible: boolean
  reason?: string
  memberId?: string
  memberState?: RoomMemberState
  balance: number
  grantRemaining: number
  availableProfit: number
  minStake: number
  maxStake: number
  comebackMinBuyIn: number
  comebackMaxBuyIn: number
  reentryCount: number
  maxReentries: number
  currentMarket: PredictionMarketView | null
  currentBet: PredictionBetView | null
  recentBets: PredictionBetView[]
  pendingReentry: ReentryRequestView | null
}

export interface DealerPredictionState {
  roomId: string
  roomRevision: number
  treasuryBalance: number
  currentMarket: PredictionMarketView | null
  bets: PredictionBetView[]
  members: RoomMemberSummary[]
  entryRequests: RoomMemberSummary[]
  reentryRequests: ReentryRequestView[]
}

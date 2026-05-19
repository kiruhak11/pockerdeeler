export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected'
export type RoomInviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'

export interface SocialUser {
  id: string
  username: string
  balance: number
}

export interface FriendItem {
  friendshipId: string
  friend: SocialUser
  createdAt: string
}

export interface FriendRequestItem {
  id: string
  status: FriendRequestStatus
  fromUser: SocialUser
  toUser: SocialUser
  createdAt: string
  updatedAt: string
  direction: 'incoming' | 'outgoing'
}

export interface RoomInviteItem {
  id: string
  roomCode: string
  roomName: string
  status: RoomInviteStatus
  fromUser: SocialUser
  toUser: SocialUser
  createdAt: string
  updatedAt: string
}

export interface RoomChatMessage {
  id: string
  roomId: string
  participantId?: string
  userId?: string
  senderName: string
  text: string
  createdAt: string
}

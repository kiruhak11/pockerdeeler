import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'

type UserClient = Pick<Prisma.TransactionClient, 'user'> | typeof prisma

export async function getLeaderboardVisibility(userId: string, client: UserClient = prisma) {
  const user = await client.user.findUnique({ where: { id: userId }, select: { leaderboardVisible: true } })
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Пользователь не найден' })
  return user.leaderboardVisible
}

export async function setLeaderboardVisibility(userId: string, leaderboardVisible: boolean, client: UserClient = prisma) {
  try {
    const user = await client.user.update({ where: { id: userId }, data: { leaderboardVisible }, select: { leaderboardVisible: true } })
    return user.leaderboardVisible
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      throw createError({ statusCode: 404, statusMessage: 'Пользователь не найден' })
    }
    throw error
  }
}

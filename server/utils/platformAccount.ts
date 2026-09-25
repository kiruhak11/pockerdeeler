import { createError } from 'h3'
import { prisma } from '../db/client'

/** Keep platform-issued accounts outside WEB phone and paid-purchase flows. */
export async function assertWebAccount(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { accountOrigin: true } })
  if (!user || user.accountOrigin !== 'WEB') {
    throw createError({ statusCode: 403, statusMessage: 'Эта возможность недоступна для аккаунта игровой платформы' })
  }
}

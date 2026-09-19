import { createError, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie } from '../../../utils/accountCookie'
import { prisma } from '../../../db/client'
import { verifyUserAuthToken } from '../../../services/userAccountService'

export default defineEventHandler(async event => {
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Требуется авторизация' })
  const parsed = z.object({ code: z.string().max(64).nullable() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректное достижение' })
  if (parsed.data.code) {
    const owned = parsed.data.code.startsWith('season:')
      ? await prisma.seasonReward.findFirst({ where: { id: parsed.data.code.slice(7), userId: auth.userId } })
      : await prisma.userAchievement.findFirst({ where: { userId: auth.userId, achievement: { code: parsed.data.code } } })
    if (!owned) throw createError({ statusCode: 403, statusMessage: 'Сначала получите это достижение' })
  }
  await prisma.user.update({ where: { id: auth.userId }, data: { selectedAchievementCode: parsed.data.code } })
  return { selectedCode: parsed.data.code }
})

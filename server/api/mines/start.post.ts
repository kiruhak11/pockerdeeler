import { startMines } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
import { minesStartInputSchema } from '../../utils/minesValidation'
import { assertRateLimit } from '../../utils/rateLimit'
export default defineEventHandler(async event => {
  assertRateLimit(event, 'mines-start', { limit: 30 })
  const parsed = minesStartInputSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    const statusMessage = field === 'stake' ? 'Введите корректную сумму ставки' : field === 'mines' ? 'Проверьте количество мин' : 'Некорректные параметры игры'
    throw createError({ statusCode: 400, statusMessage })
  }
  return startMines(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), parsed.data)
})

import { readBody } from 'h3'
import { resetBalanceSchema } from '../../utils/validation'
import { resetUserBalanceToDefault } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = resetBalanceSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const user = await resetUserBalanceToDefault({
    token: parsed.data.token,
    roomCode: parsed.data.roomCode,
    playerId: parsed.data.playerId
  })

  return { user }
})

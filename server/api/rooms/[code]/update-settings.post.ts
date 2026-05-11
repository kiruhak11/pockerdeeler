import { readBody } from 'h3'
import { updateRoomSettingsByDealer } from '../../../services/roomService'
import { updateRoomSettingsSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = updateRoomSettingsSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const state = await updateRoomSettingsByDealer(code, parsed.data)
  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})

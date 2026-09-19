import { requireAdmin, jsonSafe } from '../../utils/adminAuth'
import { miniGameEconomyState } from '../../services/miniGameEconomyService'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return jsonSafe(await miniGameEconomyState())
})

import { requireAdmin } from '../../utils/adminAuth'
import { getAdminTelegramSettings } from '../../services/adminTelegramNotificationService'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return getAdminTelegramSettings()
})

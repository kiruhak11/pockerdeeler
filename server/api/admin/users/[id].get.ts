import { requireAdmin, jsonSafe } from '../../../utils/adminAuth'
import { adminUserDetail } from '../../../services/adminDataService'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return jsonSafe(await adminUserDetail(getRouterParam(event, 'id') || ''))
})

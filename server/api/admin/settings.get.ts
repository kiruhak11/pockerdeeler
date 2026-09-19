import { requireAdmin } from '../../utils/adminAuth'
import { rewardSettings } from '../../services/rewardService'
export default defineEventHandler(async event => { await requireAdmin(event); return rewardSettings() })

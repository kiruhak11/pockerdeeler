import { requireAdmin } from '../../../utils/adminAuth'
import { finalizeSeason } from '../../../services/seasonService'
export default defineEventHandler(async event => { await requireAdmin(event); return finalizeSeason() })

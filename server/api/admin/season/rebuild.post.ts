import { z } from 'zod'
import { requireAdmin } from '../../../utils/adminAuth'
import { rebuildSeasonAwards } from '../../../services/seasonService'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const parsed = z.object({ seasonNumber: z.number().int().nonnegative() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный номер сезона' })
  return rebuildSeasonAwards(parsed.data.seasonNumber)
})

import { z } from 'zod'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { pollPhoneVerification } from '../../../services/phoneService'
import { assertRateLimit } from '../../../utils/rateLimit'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  assertRateLimit(event, 'phone-status', { limit: 30 })
  return pollPhoneVerification(event, z.object({ id: z.string().uuid() }).parse(await readBody(event)).id)
})

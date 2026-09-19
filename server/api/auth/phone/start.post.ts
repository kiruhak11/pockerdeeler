import { z } from 'zod'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { startPhoneVerification } from '../../../services/phoneService'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const input = z.object({ phone: z.string().max(30), purpose: z.enum(['register', 'recover', 'link']), requestId: z.string().uuid() }).parse(await readBody(event))
  return startPhoneVerification(event, input)
})

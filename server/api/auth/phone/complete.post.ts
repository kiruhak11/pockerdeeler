import { z } from 'zod'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { completePhoneVerification } from '../../../services/phoneService'
import { saveAccountCookie, COOKIE_MARKER } from '../../../utils/accountCookie'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const input = z.object({ id: z.string().uuid(), username: z.string().max(32).optional(), password: z.string().min(12).max(128) }).parse(await readBody(event))
  const result = await completePhoneVerification(event, input)
  saveAccountCookie(event, result.token)
  return { user: result.user, token: COOKIE_MARKER }
})

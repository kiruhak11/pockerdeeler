import { z } from 'zod'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { completePhoneVerification } from '../../../services/phoneService'
import { saveAccountCookie, COOKIE_MARKER } from '../../../utils/accountCookie'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const input = z.object({
    id: z.string().uuid(), username: z.string().max(32).optional(), password: z.string().min(12).max(128),
    ageConfirmed: z.boolean().optional(), termsAccepted: z.boolean().optional(), privacyAcknowledged: z.boolean().optional(), personalDataConsent: z.boolean().optional()
  }).strict().parse(await readBody(event))
  const hasLegalInput = input.ageConfirmed !== undefined || input.termsAccepted !== undefined || input.privacyAcknowledged !== undefined || input.personalDataConsent !== undefined
  const result = await completePhoneVerification(event, { ...input, legal: hasLegalInput ? {
    ageConfirmed: input.ageConfirmed,
    termsAccepted: input.termsAccepted,
    privacyAcknowledged: input.privacyAcknowledged,
    personalDataConsent: input.personalDataConsent
  } : undefined })
  saveAccountCookie(event, result.token)
  return { user: result.user, token: COOKIE_MARKER }
})

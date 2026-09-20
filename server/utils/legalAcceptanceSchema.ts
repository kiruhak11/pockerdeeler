import { z } from 'zod'
import { legalAcceptanceContexts } from '../services/legalService'
import { VIRTUAL_CURRENCY_PACKAGES } from '../services/paymentCatalog'
import { PREMIUM_PAYMENT_PLANS } from '../services/paymentCatalog'

export const legalAcceptanceBodySchema = z.object({
  context: z.enum(legalAcceptanceContexts),
  requestId: z.string().uuid().optional(),
  packageId: z.enum(Object.keys(VIRTUAL_CURRENCY_PACKAGES) as [keyof typeof VIRTUAL_CURRENCY_PACKAGES, ...(keyof typeof VIRTUAL_CURRENCY_PACKAGES)[]]).optional(),
  plan: z.enum(Object.keys(PREMIUM_PAYMENT_PLANS) as [keyof typeof PREMIUM_PAYMENT_PLANS, ...(keyof typeof PREMIUM_PAYMENT_PLANS)[]]).optional(),
  checkout: z.boolean().optional(),
  termsAccepted: z.boolean().optional(),
  virtualCurrencyAcknowledged: z.boolean().optional(),
  virtualChipsRulesAccepted: z.boolean().optional(),
  ageConfirmed: z.boolean().optional(),
  personalDataConsent: z.boolean().optional()
}).strict()

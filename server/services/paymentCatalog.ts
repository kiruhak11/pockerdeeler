export const PREMIUM_PAYMENT_PLANS = {
  LITE: { plan: 'LITE', name: 'Premium Lite', priceRub: 149, durationDays: 30 },
  PRO: { plan: 'PRO', name: 'Premium Pro', priceRub: 299, durationDays: 30 },
  ELITE: { plan: 'ELITE', name: 'Premium Elite', priceRub: 499, durationDays: 30 }
} as const

export type PremiumPaymentPlan = keyof typeof PREMIUM_PAYMENT_PLANS

export function getPremiumPaymentPlan(productKey: string) {
  const plan = PREMIUM_PAYMENT_PLANS[productKey as PremiumPaymentPlan]
  return plan && plan.plan === productKey ? plan : null
}

export const VIRTUAL_CURRENCY_PACKAGES = {
  'chips-99': { packageId: 'chips-99', priceRub: 99, chips: 9_900 },
  'chips-199': { packageId: 'chips-199', priceRub: 199, chips: 19_900 },
  'chips-499': { packageId: 'chips-499', priceRub: 499, chips: 49_900 },
  'chips-999': { packageId: 'chips-999', priceRub: 999, chips: 99_900 }
} as const

export type VirtualCurrencyPackageId = keyof typeof VIRTUAL_CURRENCY_PACKAGES

export function getVirtualCurrencyPackage(productKey: string) {
  const pack = VIRTUAL_CURRENCY_PACKAGES[productKey as VirtualCurrencyPackageId]
  return pack && pack.packageId === productKey ? pack : null
}

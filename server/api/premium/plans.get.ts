import { PREMIUM_FEATURES, PREMIUM_PLANS } from '../../services/premiumService'
export default defineEventHandler(() => ({ plans: PREMIUM_PLANS.map(plan => ({ ...plan, features: PREMIUM_FEATURES[plan.plan] })) }))

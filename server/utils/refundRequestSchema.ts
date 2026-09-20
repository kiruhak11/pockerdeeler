import { z } from 'zod'

export const refundRequestBodySchema = z.object({ paymentId: z.string().uuid(), reason: z.string().trim().min(5).max(1000) }).strict()

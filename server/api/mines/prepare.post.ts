import { prepareMines } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
export default defineEventHandler(event => {
  assertRateLimit(event, 'mines-prepare', { limit: 30 })
  return prepareMines(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''))
})

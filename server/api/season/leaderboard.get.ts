import { getHeader, getQuery, setHeader } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { seasonLeaderboard } from '../../services/seasonService'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const q = getQuery(event)
  return seasonLeaderboard(String(q.category || 'tableRating'), accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, ''))
})

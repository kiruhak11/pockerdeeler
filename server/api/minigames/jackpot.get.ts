import { getHeader, setHeader } from 'h3'
import { jackpotState } from '../../services/jackpotService'
import { accountCookie } from '../../utils/accountCookie'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  return jackpotState(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''))
})

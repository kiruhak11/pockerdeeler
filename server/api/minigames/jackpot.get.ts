import { jackpotState } from '../../services/jackpotService'
import { accountCookie } from '../../utils/accountCookie'
export default defineEventHandler(event => jackpotState(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, '')))

import { getHeader } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { getBlackjackState } from '../../services/blackjackService'

export default defineEventHandler(event => getBlackjackState(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') || ''))

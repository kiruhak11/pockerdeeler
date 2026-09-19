import { accountCookie } from '../../utils/accountCookie'
import { acknowledgeSeasonResult } from '../../services/seasonService'

export default defineEventHandler(event => acknowledgeSeasonResult(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') || ''))

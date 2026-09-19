import { getHeader } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { crashState } from '../../services/crashService'
export default defineEventHandler(event => crashState(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') || ''))

import { getHeader } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { seasonMe } from '../../services/seasonService'
export default defineEventHandler(event => seasonMe(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') || ''))

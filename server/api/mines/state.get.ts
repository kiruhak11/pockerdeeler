import { getMinesState } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
export default defineEventHandler(event => getMinesState(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, '')))

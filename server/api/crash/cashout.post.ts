import { accountCookie } from '../../utils/accountCookie'
import { cashoutCrash } from '../../services/crashService'
export default defineEventHandler(event => cashoutCrash(accountCookie(event)))

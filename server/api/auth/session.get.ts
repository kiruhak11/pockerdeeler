import { accountCookie } from '../../utils/accountCookie'
import { getUserProfile } from '../../services/userAccountService'
export default defineEventHandler(async event => ({ user: await getUserProfile(accountCookie(event)) }))

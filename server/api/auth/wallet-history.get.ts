import { accountCookie } from '../../utils/accountCookie'
import { getWalletHistory } from '../../services/walletService'

export default defineEventHandler(event => {
  const query = getQuery(event)
  return getWalletHistory(accountCookie(event), Number(query.limit || 50))
})

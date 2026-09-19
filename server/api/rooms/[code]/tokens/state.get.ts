import { tokenViewerState } from '../../../../services/tokenPredictionService'
import { accountCookie } from '../../../../utils/accountCookie'
export default defineEventHandler(event => tokenViewerState(getRouterParam(event,'code')?.toUpperCase() || '', accountCookie(event) || getHeader(event,'authorization')?.replace(/^Bearer /i,'')))

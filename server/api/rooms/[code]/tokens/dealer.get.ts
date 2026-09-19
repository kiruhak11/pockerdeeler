import { tokenDealerState } from '../../../../services/tokenPredictionService'
export default defineEventHandler(event => tokenDealerState(getRouterParam(event,'code')?.toUpperCase() || '', getHeader(event,'authorization')?.replace(/^Bearer /i,'') || ''))

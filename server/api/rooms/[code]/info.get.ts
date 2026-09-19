import { getLobbyInfo } from '../../../services/roomAccessService'
export default defineEventHandler(event => getLobbyInfo(getRouterParam(event, 'code')!.toUpperCase()))

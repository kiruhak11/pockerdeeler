import { readBody } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { placeCrashBet } from '../../services/crashService'
export default defineEventHandler(async event => { const body = await readBody<{ stake?: number; autoCashout?: number | null }>(event); return placeCrashBet(accountCookie(event), Number(body?.stake), body?.autoCashout == null ? null : Number(body.autoCashout)) })

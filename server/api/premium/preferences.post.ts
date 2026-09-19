import { createError, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { savePremiumSettings } from '../../services/premiumService'
const schema=z.object({theme:z.enum(['classic','midnight','emerald','gold']).optional(),frame:z.enum(['none','gold','emerald','obsidian']).optional(),interfaceStyle:z.enum(['standard','soft','contrast']).optional(),nameColor:z.enum(['gold','mint','violet']).optional(),profilePreset:z.enum(['classic','royal','neon']).optional(),animatedFrame:z.boolean().optional()}).strict()
export default defineEventHandler(async event=>{assertSameOrigin(event);const auth=await verifyUserAuthToken(accountCookie(event));if(!auth)throw createError({statusCode:401,message:'Войдите в аккаунт'});const parsed=schema.safeParse(await readBody(event));if(!parsed.success)throw createError({statusCode:400,message:'Проверьте настройки Premium'});return savePremiumSettings(auth.userId,parsed.data)})

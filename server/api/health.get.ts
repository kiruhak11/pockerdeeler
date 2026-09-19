import { prisma } from '../db/client'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  await prisma.$queryRaw`SELECT 1`
  return { status: 'ok', release: process.env.RELEASE_ID || 'development' }
})

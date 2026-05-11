import { prisma } from '../db/client'

export const snapshotService = {
  async latestSnapshot(roomId: string) {
    return prisma.gameSnapshot.findFirst({
      where: { roomId },
      orderBy: { createdAt: 'desc' }
    })
  }
}

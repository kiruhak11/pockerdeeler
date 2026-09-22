import { validateRoomSecretPepper } from '../utils/roomSecretPepper'

export default defineNitroPlugin(() => {
  // Build-time prerendering is not the production server process; validate on runtime startup.
  if (import.meta.prerender) return
  validateRoomSecretPepper()
})

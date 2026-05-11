export function getHttpErrorMessage(error: unknown, fallback = 'Произошла ошибка'): string {
  if (!error || typeof error !== 'object') {
    return fallback
  }

  const maybe = error as {
    statusMessage?: string
    message?: string
    data?: {
      statusMessage?: string
      message?: string
    }
  }

  if (maybe.data?.statusMessage) {
    return maybe.data.statusMessage
  }

  if (maybe.data?.message) {
    return maybe.data.message
  }

  if (maybe.statusMessage) {
    return maybe.statusMessage
  }

  if (maybe.message) {
    return maybe.message
  }

  return fallback
}

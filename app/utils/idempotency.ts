export function createClientRequestId(prefix = 'req'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

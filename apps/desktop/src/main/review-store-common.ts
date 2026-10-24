export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fail(reason: string, message: string): Error & { reason: string } {
  return Object.assign(new Error(message), { reason });
}

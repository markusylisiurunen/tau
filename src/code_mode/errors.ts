export function codeModeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

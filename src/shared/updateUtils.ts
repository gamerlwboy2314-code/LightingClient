export function summarizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message :
    typeof error === 'string' ? error : 'Unexpected update error.'
  if (/Cannot find latest\.yml/i.test(message)) {
    return 'The latest GitHub release has no updater files yet. Publish it through the release workflow, then retry.'
  }

  const firstLine = message.split(/\r?\n/, 1)[0]
    .replace(/^Error invoking remote method 'updates:[^']+':\s*/i, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine || 'Unexpected update error.'
}

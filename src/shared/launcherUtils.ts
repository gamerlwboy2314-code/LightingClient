import type { LauncherSettings } from './types'

export const MIN_SUPPORTED_VERSION = '1.21.11'
const AZURE_PORTAL_CLIENT_ID = '74658136-14ec-4630-ad9b-26e160ff0fc6'

export function isAzurePortalClientId(value: string): boolean {
  return value.trim().toLowerCase() === AZURE_PORTAL_CLIENT_ID
}

export function isValidMicrosoftClientId(value: string): boolean {
  const clientId = value.trim()
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId) &&
    !isAzurePortalClientId(clientId)
}

export function isSupportedRelease(version: string): boolean {
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) return false
  const actual = version.split('.').map(Number)
  const minimum = MIN_SUPPORTED_VERSION.split('.').map(Number)

  for (let i = 0; i < Math.max(actual.length, minimum.length); i++) {
    const difference = (actual[i] ?? 0) - (minimum[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export function parseJavaMajorVersion(output: string): number | undefined {
  const match = output.match(/(?:openjdk|java)(?: version)?\s+"?(\d+)(?:\.(\d+))?/i)
  if (!match) return undefined

  const major = Number(match[1])
  return major === 1 ? Number(match[2]) : major
}

export function parseJavaArgs(value: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '\\' && quote === '"') {
      const next = value[index + 1]
      if (next === '"' || next === '\\') {
        current += next
        index++
      } else {
        current += character
      }
    } else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += character
    }

    if (args.length > 64 || current.length > 2048) {
      throw new Error('Java arguments are too long or contain too many values.')
    }
  }

  if (quote) throw new Error('Java arguments contain an unclosed quote.')
  if (current) args.push(current)
  if (args.length > 64) throw new Error('Java arguments contain too many values.')
  return args
}

export function validateLauncherSettings(value: unknown): LauncherSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Settings must be an object.')
  }
  const input = value as Record<string, unknown>
  const stringValue = (key: string, maximumLength: number): string => {
    const item = input[key]
    if (typeof item !== 'string' || item.length > maximumLength || item.includes('\0')) {
      throw new Error(`Invalid ${key} setting.`)
    }
    return item
  }
  const numberValue = (key: string, minimum: number, maximum: number): number => {
    const item = input[key]
    if (typeof item !== 'number' || !Number.isInteger(item) || item < minimum || item > maximum) {
      throw new Error(`Invalid ${key} setting.`)
    }
    return item
  }

  const gameDir = stringValue('gameDir', 4096).trim()
  if (!gameDir) throw new Error('Choose a Minecraft game directory.')

  const minRam = numberValue('minRam', 1, 64)
  const maxRam = numberValue('maxRam', minRam, 64)
  const width = numberValue('width', 320, 7680)
  const height = numberValue('height', 320, 4320)
  const javaPath = stringValue('javaPath', 4096).trim()
  const javaArgs = stringValue('javaArgs', 4096)
  parseJavaArgs(javaArgs)

  const theme = input.theme
  if (theme !== 'dark' && theme !== 'light') throw new Error('Invalid theme setting.')

  return { gameDir, minRam, maxRam, javaPath, javaArgs, width, height, theme }
}

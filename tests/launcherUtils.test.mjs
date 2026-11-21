import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAzurePortalClientId,
  isSupportedRelease,
  isValidMicrosoftClientId,
  parseJavaArgs,
  parseJavaMajorVersion,
  validateLauncherSettings
} from '../src/shared/launcherUtils.ts'

const settings = {
  gameDir: 'C:\\Minecraft',
  minRam: 2,
  maxRam: 6,
  javaPath: '',
  javaArgs: '',
  width: 1280,
  height: 720,
  theme: 'dark'
}

test('release filtering supports the minimum and newer Mojang release numbering', () => {
  assert.equal(isSupportedRelease('1.21.11'), true)
  assert.equal(isSupportedRelease('1.21.10'), false)
  assert.equal(isSupportedRelease('1.22.0'), true)
  assert.equal(isSupportedRelease('26.3'), true)
  assert.equal(isSupportedRelease('26.1.2'), true)
  assert.equal(isSupportedRelease('24w14a'), false)
  assert.equal(isSupportedRelease('not-a-version'), false)
})

test('Java version parsing handles current and legacy runtime output', () => {
  assert.equal(parseJavaMajorVersion('openjdk version "25.0.1" 2026-01-20'), 25)
  assert.equal(parseJavaMajorVersion('java version "1.8.0_402"'), 8)
  assert.equal(parseJavaMajorVersion('openjdk 21.0.6 2025-01-21'), 21)
  assert.equal(parseJavaMajorVersion('not java output'), undefined)
})

test('Java arguments preserve quoted values without invoking a shell', () => {
  assert.deepEqual(parseJavaArgs('-XX:+UseG1GC -Dmy.property="a value"'), [
    '-XX:+UseG1GC',
    '-Dmy.property=a value'
  ])
  assert.deepEqual(parseJavaArgs('-Djava.path="C:\\Program Files\\Java\\bin"'), [
    '-Djava.path=C:\\Program Files\\Java\\bin'
  ])
  assert.deepEqual(parseJavaArgs(''), [])
  assert.throws(() => parseJavaArgs('-Dvalue="unfinished'), /unclosed quote/)
})

test('launcher settings enforce RAM, resolution, and theme bounds', () => {
  assert.deepEqual(validateLauncherSettings(settings), settings)
  assert.deepEqual(validateLauncherSettings({ ...settings, microsoftClientId: 'legacy-user-value' }), settings)
  assert.throws(() => validateLauncherSettings({ ...settings, maxRam: 1 }), /maxRam/)
  assert.throws(() => validateLauncherSettings({ ...settings, width: 0 }), /width/)
  assert.throws(() => validateLauncherSettings({ ...settings, theme: 'system' }), /theme/)
})

test('Microsoft client IDs must be GUIDs, allowing surrounding whitespace', () => {
  assert.equal(isValidMicrosoftClientId('12345678-1234-1234-1234-123456789abc'), true)
  assert.equal(isValidMicrosoftClientId('  12345678-1234-1234-1234-123456789ABC  '), true)
  assert.equal(isValidMicrosoftClientId(''), false)
  assert.equal(isValidMicrosoftClientId('not-a-client-id'), false)
  assert.equal(isValidMicrosoftClientId('74658136-14ec-4630-ad9b-26e160ff0fc6'), false)
  assert.equal(isAzurePortalClientId(' 74658136-14EC-4630-AD9B-26E160FF0FC6 '), true)
})

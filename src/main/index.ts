import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node'
import type { AccountInfo, ICachePlugin, TokenCacheContext } from '@azure/msal-node'
import { getLoaderArtifactListFor, installFabric, installTask } from '@xmcl/installer'
import type { MinecraftVersionBaseInfo } from '@xmcl/installer'
import { launch, Version as CoreVersion } from '@xmcl/core'
import { MojangClient, MicrosoftAuthenticator } from '@xmcl/user'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { isSupportedRelease, isValidMicrosoftClientId, parseJavaArgs, parseJavaMajorVersion, validateLauncherSettings } from '../shared/launcherUtils'
import type { Cape, LaunchEvent, LauncherSettings, ModInfo, Player, PluginInfo, PluginUpdate, VersionInfo, WorldInfo } from '../shared/types'
import { MICROSOFT_OAUTH_CLIENT_ID } from './authConfig'
import {
  listCompatibleModrinthVersions,
  PLUGIN_CATALOG,
  parsePinnedModrinthVersion,
  resolveFirstInstallableModrinthVersion,
  UnsupportedModrinthDependencyError
} from './pluginUtils'
import type { ModrinthDependency, ModrinthFile, ModrinthVersion, PluginDefinition } from './pluginUtils'
import { getWorldGameMode, parseWorldMetadata } from './worldUtils'

const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const MODRINTH_API_URL = 'https://api.modrinth.com/v2'
const MODRINTH_USER_AGENT = 'LightingClient/1.0.1'
const MAX_REQUIRED_MODS = 30
const MAX_MOD_FILE_BYTES = 100 * 1024 * 1024
const MINECRAFT_SCOPES = ['XboxLive.signin', 'offline_access']
const execFileAsync = promisify(execFile)

type ManifestVersion = MinecraftVersionBaseInfo & { type: string }
type VersionManifest = { versions: ManifestVersion[] }
type MinecraftSession = {
  accessToken: string
  account: AccountInfo
  expiresAt: number
  player: Player
}

const DATA_DIR = app.getPath('userData')
const LEGACY_DATA_DIRS = [
  join(app.getPath('appData'), 'Blockcraft Launcher', 'blockcraft'),
  join(app.getPath('userData'), 'blockcraft')
]
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
const DEFAULT_SETTINGS: LauncherSettings = {
  gameDir: join(app.getPath('appData'), '.minecraft-lightingclient'),
  minRam: 2,
  maxRam: 6,
  javaPath: '',
  javaArgs: '',
  width: 1280,
  height: 720,
  theme: 'dark'
}

let mainWindow: BrowserWindow | null = null
let player: Player | null = null
let minecraftSession: MinecraftSession | null = null
let restoreError: string | null = null
let launchInProgress = false
let authOperationInProgress = false
let modOperationInProgress = false
let minecraftProcess: Awaited<ReturnType<typeof launch>> | null = null

class NoJavaOwnershipError extends Error {}

function emit(event: LaunchEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:event', event)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, value, { flag: 'wx', mode: 0o600 })
  await rename(temporaryPath, path)
}

async function migrateLegacyData(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  for (const legacyDirectory of LEGACY_DATA_DIRS) {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(legacyDirectory, { withFileTypes: true })
    } catch (error) {
      if (isMissingFile(error)) continue
      throw error
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        await copyFile(join(legacyDirectory, entry.name), join(DATA_DIR, entry.name), constants.COPYFILE_EXCL)
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') {
          throw error
        }
      }
    }
  }
}

function normalizeSettings(value: unknown): LauncherSettings {
  const parsed = validateLauncherSettings(value)
  if (!isAbsolute(parsed.gameDir)) throw new Error('The Minecraft game directory must be an absolute path.')
  if (parsed.javaPath && !isAbsolute(parsed.javaPath)) throw new Error('The Java executable path must be absolute.')
  return parsed
}

async function getSettings(): Promise<LauncherSettings> {
  const data = await readOptionalFile(SETTINGS_FILE)
  if (!data) return DEFAULT_SETTINGS

  const saved: unknown = JSON.parse(data.toString('utf8'))
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    throw new Error('The saved launcher settings are invalid. Remove or repair settings.json to continue.')
  }
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...saved })
  return settings
}

function validateIpcSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('This request is not from the launcher window.')
  }
}

function configureContentSecurityPolicy(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  let devOrigin = ''
  let devSocketOrigin = ''
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error('The development renderer must use a localhost URL.')
    }
    devOrigin = url.origin
    devSocketOrigin = `ws://${url.host}`
  }

  const policy = [
    "default-src 'self'",
    `script-src 'self'${rendererUrl ? " 'unsafe-eval' 'unsafe-inline' " + devOrigin : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://textures.minecraft.net",
    `connect-src 'self'${rendererUrl ? ` ${devOrigin} ${devSocketOrigin}` : ''}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

async function createWindow(): Promise<void> {
  const rendererPath = join(__dirname, '../renderer/index.html')
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const allowedFileUrl = pathToFileURL(rendererPath).href
  const allowedDevOrigin = devUrl ? new URL(devUrl).origin : undefined

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#0b0e14',
    icon: join(__dirname, '../../build/lightingclient.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
    let allowed = url === allowedFileUrl
    if (allowedDevOrigin) {
      try {
        allowed = new URL(url).origin === allowedDevOrigin
      } catch {
        allowed = false
      }
    }
    if (!allowed) event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', preventUntrustedNavigation)
  mainWindow.webContents.on('will-redirect', preventUntrustedNavigation)

  if (devUrl) await mainWindow.loadURL(devUrl)
  else await mainWindow.loadFile(rendererPath)
}

function getAuthCachePath(): string {
  const key = createHash('sha256').update(MICROSOFT_OAUTH_CLIENT_ID).digest('hex')
  return join(DATA_DIR, `msal-${key}.bin`)
}

function createEncryptedCachePlugin(): ICachePlugin {
  const cachePath = getAuthCachePath()
  return {
    async beforeCacheAccess(context: TokenCacheContext) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS secure storage is unavailable; Microsoft sessions cannot be restored.')
      }
      const encryptedCache = await readOptionalFile(cachePath)
      if (encryptedCache?.length) {
        context.tokenCache.deserialize(safeStorage.decryptString(encryptedCache))
      }
    },
    async afterCacheAccess(context: TokenCacheContext) {
      if (!context.cacheHasChanged) return
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS secure storage is unavailable; refusing to save Microsoft credentials.')
      }
      await atomicWrite(cachePath, safeStorage.encryptString(context.tokenCache.serialize()))
    }
  }
}

function createAuthClient(): PublicClientApplication {
  if (!isValidMicrosoftClientId(MICROSOFT_OAUTH_CLIENT_ID)) {
    throw new Error('Microsoft sign-in is unavailable because this build has no valid publisher-configured OAuth client ID.')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is unavailable; refusing to start Microsoft sign-in.')
  }

  return new PublicClientApplication({
    auth: {
      clientId: MICROSOFT_OAUTH_CLIENT_ID,
      authority: 'https://login.microsoftonline.com/consumers'
    },
    cache: { cachePlugin: createEncryptedCachePlugin() }
  })
}

function isInteractionRequired(error: unknown): boolean {
  return error instanceof InteractionRequiredAuthError ||
    (typeof error === 'object' && error !== null && 'errorCode' in error &&
      typeof error.errorCode === 'string' &&
      ['interaction_required', 'login_required', 'invalid_grant'].includes(error.errorCode))
}

async function fetchJson(url: string, description: string, authorization?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: authorization ? { Authorization: `Bearer ${authorization}` } : undefined,
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    throw new Error(`${description} failed with HTTP ${response.status}.`)
  }
  return response.json() as Promise<unknown>
}

function parseMinecraftProfile(value: unknown): Player {
  if (typeof value !== 'object' || value === null ||
      !('id' in value) || typeof value.id !== 'string' ||
      !('name' in value) || typeof value.name !== 'string' ||
      !value.id || !value.name) {
    throw new Error('Minecraft Services returned an invalid player profile.')
  }

  const textureUrl = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.hostname === 'textures.minecraft.net' ? url.href : null
    } catch {
      return null
    }
  }

  const skins: Player['skins'] = []
  if ('skins' in value && Array.isArray(value.skins)) {
    for (const skin of value.skins) {
      if (typeof skin === 'object' && skin !== null &&
          'id' in skin && typeof skin.id === 'string' && skin.id &&
          'state' in skin && typeof skin.state === 'string') {
        skins.push({
          id: skin.id,
          name: 'alias' in skin && typeof skin.alias === 'string' ? skin.alias : 'Minecraft skin',
          url: 'url' in skin ? textureUrl(skin.url) : null,
          state: skin.state
        })
      }
    }
  }

  const capes: Cape[] = []
  if ('capes' in value && Array.isArray(value.capes)) {
    for (const cape of value.capes) {
      if (typeof cape === 'object' && cape !== null &&
          'id' in cape && typeof cape.id === 'string' && cape.id &&
          'state' in cape && typeof cape.state === 'string') {
        capes.push({
          id: cape.id,
          name: 'alias' in cape && typeof cape.alias === 'string' ? cape.alias : 'Minecraft cape',
          url: 'url' in cape ? textureUrl(cape.url) : null,
          active: cape.state === 'ACTIVE'
        })
      }
    }
  }
  return { name: value.name, uuid: value.id, skins, capes }
}

function isOfficialMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      ['launchermeta.mojang.com', 'piston-meta.mojang.com'].includes(url.hostname)
  } catch {
    return false
  }
}

async function getVersionManifest(): Promise<VersionManifest> {
  const value = await fetchJson(VERSION_MANIFEST_URL, 'Mojang version manifest')
  if (typeof value !== 'object' || value === null || !('versions' in value) ||
      !Array.isArray(value.versions)) {
    throw new Error('Mojang returned an invalid version manifest.')
  }

  const versions = value.versions.filter((item): item is ManifestVersion =>
    typeof item === 'object' && item !== null &&
    'id' in item && typeof item.id === 'string' &&
    'type' in item && typeof item.type === 'string' &&
    'url' in item && typeof item.url === 'string' && isOfficialMetadataUrl(item.url))
  if (!versions.length) throw new Error('Mojang returned no valid Minecraft version metadata.')
  return { versions }
}

function getSupportedReleases(manifest: VersionManifest): ManifestVersion[] {
  return manifest.versions.filter((version) =>
    version.type === 'release' && isSupportedRelease(version.id))
}

async function getLauncherVersions(manifest: VersionManifest, gameDir: string): Promise<VersionInfo[]> {
  const releases = getSupportedReleases(manifest)
  let entries: Dirent<string>[]
  try {
    entries = await readdir(join(gameDir, 'versions'), { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) entries = []
    else throw error
  }

  const fabricVersions = entries.flatMap((entry): VersionInfo[] => {
    if (!entry.isDirectory()) return []
    const baseVersion = releases.find((version) => entry.name.startsWith(`${version.id}-fabric`))
    if (!baseVersion) return []
    const loaderVersion = entry.name.slice(`${baseVersion.id}-fabric`.length)
    if (!/^\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(loaderVersion)) return []
    return [{ id: entry.name, type: 'fabric', baseVersion: baseVersion.id }]
  })

  return [
    ...releases.map(({ id, type }) => ({ id, type })),
    ...fabricVersions
  ]
}

function getLaunchBaseVersion(versionId: string, releases: ManifestVersion[]): {
  version: ManifestVersion
  isFabric: boolean
} | undefined {
  const vanilla = releases.find((version) => version.id === versionId)
  if (vanilla) return { version: vanilla, isFabric: false }

  const fabric = releases.find((version) => versionId.startsWith(`${version.id}-fabric`))
  if (!fabric) return undefined
  const loaderVersion = versionId.slice(`${fabric.id}-fabric`.length)
  if (!/^\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(loaderVersion)) return undefined
  return { version: fabric, isFabric: true }
}

function modsDirectory(gameDir: string): string {
  return join(gameDir, 'mods')
}

function worldsDirectory(gameDir: string): string {
  return join(gameDir, 'saves')
}

async function listWorlds(gameDir: string): Promise<WorldInfo[]> {
  const directory = worldsDirectory(gameDir)
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }

  const worlds: WorldInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worldDirectory = join(directory, entry.name)
    const levelData = await readOptionalFile(join(worldDirectory, 'level.dat'))
    if (!levelData) continue

    let metadata
    try {
      metadata = parseWorldMetadata(levelData)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid world metadata.'
      throw new Error(`Could not read world "${entry.name}": ${reason}`)
    }

    const directoryStats = await stat(worldDirectory)
    const createdAt = directoryStats.birthtime.getTime() > 0
      ? directoryStats.birthtime.toISOString()
      : null
    const lastPlayedTime = metadata.lastPlayed === undefined ? NaN : Number(metadata.lastPlayed)
    const lastPlayed = Number.isSafeInteger(lastPlayedTime) && lastPlayedTime > 0
      ? new Date(lastPlayedTime).toISOString()
      : null
    const iconData = await readOptionalFile(join(worldDirectory, 'icon.png'))
    const hasPngSignature = iconData?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const icon = iconData && iconData.length <= 2 * 1024 * 1024 && hasPngSignature
      ? `data:image/png;base64,${iconData.toString('base64')}`
      : null

    worlds.push({
      id: entry.name,
      name: metadata.name?.trim() || entry.name,
      createdAt,
      lastPlayed,
      gameMode: getWorldGameMode(metadata.gameType, metadata.hardcore),
      icon
    })
  }

  return worlds.sort((left, right) =>
    (right.lastPlayed ? Date.parse(right.lastPlayed) : 0) -
    (left.lastPlayed ? Date.parse(left.lastPlayed) : 0) ||
    left.name.localeCompare(right.name)
  )
}

function validateModName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || basename(value) !== value ||
      !/^[^<>:"/\\|?*\u0000-\u001f]+\.jar$/i.test(value)) {
    throw new Error('Invalid mod file name.')
  }
  return value
}

async function ensurePathDoesNotExist(path: string): Promise<void> {
  try {
    await access(path)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  throw new Error('A mod with that file name already exists.')
}

async function listMods(gameDir: string): Promise<ModInfo[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(modsDirectory(gameDir), { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }

  return entries.flatMap((entry): ModInfo[] => {
    if (!entry.isFile()) return []
    if (entry.name.toLowerCase().endsWith('.jar')) {
      return [{ name: entry.name, enabled: true }]
    }
    if (entry.name.toLowerCase().endsWith('.jar.disabled')) {
      return [{ name: entry.name.slice(0, -'.disabled'.length), enabled: false }]
    }
    return []
  }).sort((left, right) => left.name.localeCompare(right.name))
}

function pluginMods(plugin: PluginDefinition, mods: ModInfo[]): ModInfo[] {
  return mods.filter((mod) => plugin.filenameMatches.some((part) =>
    mod.name.toLowerCase().includes(part)
  ))
}

function pluginInfo(
  plugin: PluginDefinition,
  mods: ModInfo[],
  version: ModrinthVersion | undefined
): PluginInfo {
  const installed = pluginMods(plugin, mods)
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    installed: installed.length > 0,
    enabled: installed.some((mod) => mod.enabled),
    supported: version !== undefined,
    version: version?.version ?? null
  }
}

async function fetchModrinthJson(url: string, description: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': MODRINTH_USER_AGENT },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`${description} failed with HTTP ${response.status}.`)
  return response.json() as Promise<unknown>
}

function validateModrinthId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error('Modrinth returned an invalid project or version ID.')
  }
  return value
}

async function getModrinthProjectVersion(
  projectId: string,
  gameVersion: string
): Promise<ModrinthVersion | undefined> {
  return (await getModrinthProjectVersions(projectId, gameVersion))[0]
}

async function getModrinthProjectVersions(
  projectId: string,
  gameVersion: string
): Promise<ModrinthVersion[]> {
  const url = new URL(`${MODRINTH_API_URL}/project/${validateModrinthId(projectId)}/version`)
  url.searchParams.set('game_versions', JSON.stringify([gameVersion]))
  url.searchParams.set('loaders', JSON.stringify(['fabric']))
  const result = await fetchModrinthJson(url.href, 'Modrinth version lookup')
  return listCompatibleModrinthVersions(result, projectId, gameVersion)
}

async function getModrinthPinnedVersion(
  versionId: string,
  gameVersion: string,
  expectedProjectId?: string
): Promise<ModrinthVersion> {
  const id = validateModrinthId(versionId)
  const result = await fetchModrinthJson(`${MODRINTH_API_URL}/version/${id}`, 'Modrinth dependency lookup')
  if (typeof result !== 'object' || result === null || !('project_id' in result)) {
    throw new Error('Modrinth returned an invalid dependency version.')
  }
  const projectId = validateModrinthId(result.project_id)
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new Error('Modrinth returned a dependency from the wrong project.')
  }
  if (!('game_versions' in result) || !Array.isArray(result.game_versions) ||
      !result.game_versions.includes(gameVersion) ||
      !('loaders' in result) || !Array.isArray(result.loaders) ||
      !result.loaders.includes('fabric')) {
    throw new UnsupportedModrinthDependencyError('A required dependency has no compatible Fabric release.')
  }
  return parsePinnedModrinthVersion(result, projectId, gameVersion)
}

async function resolveModrinthVersion(
  dependency: ModrinthDependency,
  gameVersion: string
): Promise<ModrinthVersion> {
  if (dependency.versionId) {
    return getModrinthPinnedVersion(dependency.versionId, gameVersion, dependency.projectId)
  }
  if (!dependency.projectId) throw new Error('Modrinth returned an incomplete dependency.')
  const version = await getModrinthProjectVersion(dependency.projectId, gameVersion)
  if (!version) {
    throw new UnsupportedModrinthDependencyError(`A required mod has no Fabric release for Minecraft ${gameVersion}.`)
  }
  return version
}

async function resolveModrinthInstallPlan(
  root: ModrinthVersion,
  gameVersion: string
): Promise<ModrinthVersion[]> {
  const resolved = new Map<string, ModrinthVersion>()
  const visiting = new Set<string>()
  const plan: ModrinthVersion[] = []

  async function visit(version: ModrinthVersion): Promise<void> {
    const previous = resolved.get(version.projectId)
    if (previous) {
      if (previous.id !== version.id) {
        throw new UnsupportedModrinthDependencyError('The selected mod requires conflicting versions of a dependency.')
      }
      return
    }
    if (visiting.has(version.projectId)) throw new Error('Modrinth returned a cyclic dependency list.')
    if (resolved.size + visiting.size >= MAX_REQUIRED_MODS) {
      throw new Error('The selected mod requires too many dependencies to install safely.')
    }

    visiting.add(version.projectId)
    for (const dependency of version.dependencies) {
      await visit(await resolveModrinthVersion(dependency, gameVersion))
    }
    visiting.delete(version.projectId)
    resolved.set(version.projectId, version)
    plan.push(version)
  }

  await visit(root)
  return plan
}

async function getModrinthInstallableVersion(
  projectId: string,
  gameVersion: string
): Promise<{ version: ModrinthVersion; installPlan: ModrinthVersion[] } | undefined> {
  const candidates = await getModrinthProjectVersions(projectId, gameVersion)
  return resolveFirstInstallableModrinthVersion(
    candidates,
    (version) => resolveModrinthInstallPlan(version, gameVersion)
  )
}

async function downloadModrinthFile(file: ModrinthFile, directory: string): Promise<void> {
  const filename = validateModName(file.filename)
  const target = join(directory, filename)
  const disabledTarget = `${target}.disabled`

  for (const [path, disabled] of [[target, false], [disabledTarget, true]] as const) {
    const existing = await readOptionalFile(path)
    if (!existing) continue
    const hash = createHash('sha512').update(existing).digest('hex')
    if (hash !== file.sha512) {
      throw new Error(`${filename} already exists but does not match the verified Modrinth file.`)
    }
    if (disabled) await rename(path, target)
    return
  }

  const response = await fetch(file.url, {
    headers: { 'User-Agent': MODRINTH_USER_AGENT },
    signal: AbortSignal.timeout(90_000)
  })
  if (!response.ok) throw new Error(`Downloading ${filename} failed with HTTP ${response.status}.`)
  let finalUrl: URL
  try {
    finalUrl = new URL(response.url)
  } catch {
    throw new Error(`Modrinth returned an invalid download URL for ${filename}.`)
  }
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'cdn.modrinth.com') {
    throw new Error(`Refusing to download ${filename} from an untrusted host.`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error(`The Modrinth download for ${filename} had no response body.`)
  const chunks: Buffer[] = []
  let totalSize = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    totalSize += chunk.value.byteLength
    if (totalSize > file.size || totalSize > MAX_MOD_FILE_BYTES) {
      await reader.cancel()
      throw new Error(`The Modrinth download for ${filename} exceeded its advertised size.`)
    }
    chunks.push(Buffer.from(chunk.value))
  }
  if (totalSize !== file.size) {
    throw new Error(`The Modrinth download for ${filename} had an unexpected size.`)
  }

  const contents = Buffer.concat(chunks, totalSize)
  if (createHash('sha512').update(contents).digest('hex') !== file.sha512) {
    throw new Error(`The Modrinth download for ${filename} failed its SHA-512 verification.`)
  }

  const temporary = join(directory, `${filename}.${randomUUID()}.tmp`)
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
  await rename(temporary, target)
}

async function setInstalledPluginMods(
  gameDir: string,
  mods: ModInfo[],
  plugin: PluginDefinition,
  enabled: boolean
): Promise<ModInfo[]> {
  const directory = modsDirectory(gameDir)
  const selected = pluginMods(plugin, mods)
  for (const mod of selected) {
    if (mod.enabled === enabled) continue
    const source = join(directory, mod.enabled ? mod.name : `${mod.name}.disabled`)
    const destination = join(directory, enabled ? mod.name : `${mod.name}.disabled`)
    await ensurePathDoesNotExist(destination)
    await rename(source, destination)
  }
  return listMods(gameDir)
}

async function listPlugins(gameDir: string, gameVersion: string): Promise<PluginInfo[]> {
  const mods = await listMods(gameDir)
  const versions = await Promise.all(PLUGIN_CATALOG.map((plugin) =>
    getModrinthProjectVersion(plugin.projectId, gameVersion)
  ))
  return PLUGIN_CATALOG.map((plugin, index) => pluginInfo(plugin, mods, versions[index]))
}

async function authenticateMinecraft(
  msAccessToken: string,
  account: AccountInfo
): Promise<MinecraftSession> {
  const authenticator = new MicrosoftAuthenticator()
  const { minecraftXstsResponse } = await authenticator.acquireXBoxToken(msAccessToken)
  const claims = minecraftXstsResponse.DisplayClaims?.xui?.[0]
  if (!claims?.uhs || !minecraftXstsResponse.Token) {
    throw new Error('Microsoft did not return the Xbox credentials required by Minecraft Services.')
  }

  const minecraftAuth = await authenticator.loginMinecraftWithXBox(claims.uhs, minecraftXstsResponse.Token)
  if (!minecraftAuth.access_token) {
    throw new Error('Minecraft Services did not return a Minecraft access token.')
  }

  const ownershipValue = await fetchJson(
    'https://api.minecraftservices.com/entitlements/mcstore',
    'Minecraft Java ownership verification',
    minecraftAuth.access_token
  )
  if (typeof ownershipValue !== 'object' || ownershipValue === null ||
      !('items' in ownershipValue) || !Array.isArray(ownershipValue.items) ||
      !ownershipValue.items.some((item) =>
        typeof item === 'object' && item !== null && 'name' in item &&
        (item.name === 'game_minecraft' || item.name === 'product_minecraft'))) {
    throw new NoJavaOwnershipError('This Microsoft account does not own Minecraft Java Edition.')
  }

  const profileValue = await fetchJson(
    'https://api.minecraftservices.com/minecraft/profile',
    'Minecraft Java profile lookup',
    minecraftAuth.access_token
  )
  return {
    accessToken: minecraftAuth.access_token,
    account,
    expiresAt: Date.now() + minecraftAuth.expires_in * 1000,
    player: parseMinecraftProfile(profileValue)
  }
}

async function restoreSession(): Promise<void> {
  try {
    if (!isValidMicrosoftClientId(MICROSOFT_OAUTH_CLIENT_ID)) return
    const cache = await readOptionalFile(getAuthCachePath())
    if (!cache) return

    const client = createAuthClient()
    const accounts = await client.getAllAccounts()
    if (!accounts.length) return
    const result = await client.acquireTokenSilent({ account: accounts[0], scopes: MINECRAFT_SCOPES })
    if (!result.accessToken || !result.account) throw new Error('Microsoft did not restore an active account session.')
    minecraftSession = await authenticateMinecraft(result.accessToken, result.account)
    player = minecraftSession.player
  } catch (error) {
    if (error instanceof NoJavaOwnershipError) {
      player = null
      minecraftSession = null
      restoreError = error.message
    } else if (isInteractionRequired(error)) {
      player = null
      minecraftSession = null
      restoreError = 'Your Microsoft session expired or was revoked. Sign in again to continue.'
    } else {
      player = null
      minecraftSession = null
      restoreError = error instanceof Error ? `Could not restore the Microsoft session: ${error.message}` :
        'Could not restore the Microsoft session.'
    }
  }
}

async function checkJava(javaPath: string, requiredMajor: number, versionId: string): Promise<void> {
  const executable = javaPath || 'java'
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['-version'], {
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf8'
    })
    const actualMajor = parseJavaMajorVersion(`${stderr}\n${stdout}`)
    if (actualMajor === undefined) throw new Error('Could not determine the Java runtime version.')
    if (actualMajor < requiredMajor) {
      throw new Error(`Minecraft ${versionId} requires Java ${requiredMajor} or newer; found Java ${actualMajor}.`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Minecraft ')) throw error
    if (error instanceof Error && error.message.startsWith('Could not determine')) throw error
    throw new Error(`Java ${requiredMajor} or newer is required. Install a compatible Java runtime or set its executable path in Settings.`)
  }
}

async function refreshMinecraftSessionIfNeeded(): Promise<void> {
  const current = minecraftSession
  if (!current) throw new Error('Sign in with Microsoft before launching.')
  if (current.expiresAt > Date.now() + 60_000) return

  const client = createAuthClient()
  try {
    const result = await client.acquireTokenSilent({ account: current.account, scopes: MINECRAFT_SCOPES })
    if (!result.accessToken || !result.account) throw new Error('Microsoft did not refresh the account session.')
    minecraftSession = await authenticateMinecraft(result.accessToken, result.account)
    player = minecraftSession.player
  } catch (error) {
    if (isInteractionRequired(error)) {
      player = null
      minecraftSession = null
      throw new Error('Your Microsoft session expired or was revoked. Sign in again before launching.')
    }
    throw error
  }
}

async function installFabricProfile(value: unknown): Promise<string> {
  if (launchInProgress) throw new Error('A Minecraft installation or launch is already in progress.')
  if (typeof value !== 'string') throw new Error('Choose a supported Minecraft version before installing Fabric.')

  launchInProgress = true
  try {
    const manifest = await getVersionManifest()
    const version = getSupportedReleases(manifest).find((item) => item.id === value)
    if (!version) throw new Error(`Minecraft release ${value} is unavailable or not supported by this launcher.`)

    const settings = await getSettings()
    const loaders = await getLoaderArtifactListFor(version.id)
    const loader = loaders.find((item) => item.loader.stable)
    if (!loader) throw new Error(`Fabric has no stable loader available for Minecraft ${version.id}.`)

    await mkdir(settings.gameDir, { recursive: true })
    const profileId = await installFabric({
      minecraftVersion: version.id,
      version: loader.loader.version,
      minecraft: settings.gameDir
    })
    emit({ type: 'status', message: `Fabric ${loader.loader.version} installed for Minecraft ${version.id}.` })
    return profileId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fabric could not be installed.'
    emit({ type: 'error', message })
    throw error
  } finally {
    launchInProgress = false
  }
}

async function setPluginEnabled(value: unknown, enabled: unknown, gameVersion: unknown): Promise<PluginUpdate> {
  const plugin = PLUGIN_CATALOG.find((item) => item.id === value)
  if (!plugin) throw new Error('Choose a supported plugin.')
  if (typeof enabled !== 'boolean') throw new Error('Invalid plugin enabled state.')
  if (typeof gameVersion !== 'string' || !isSupportedRelease(gameVersion)) {
    throw new Error('Choose a supported Minecraft release before managing plugins.')
  }
  if (modOperationInProgress) throw new Error('A mod file operation is already in progress.')

  modOperationInProgress = true
  try {
    if (minecraftProcess && !minecraftProcess.killed) {
      throw new Error('Close Minecraft before changing plugins. Changes apply the next time the game starts.')
    }

    const settings = await getSettings()
    const installedMods = await listMods(settings.gameDir)
    const installedPluginMods = pluginMods(plugin, installedMods)
    if (enabled && installedPluginMods.length > 0 && installedPluginMods.every((mod) => mod.enabled)) {
      return {
        id: plugin.id,
        installed: true,
        enabled: true
      }
    }
    if (!enabled && installedPluginMods.length > 0 && installedPluginMods.every((mod) => !mod.enabled)) {
      return {
        id: plugin.id,
        installed: true,
        enabled: false
      }
    }

    let modVersion: ModrinthVersion | undefined
    let fabricVersionId: string | undefined
    if (enabled) {
      const compatibleInstall = await getModrinthInstallableVersion(plugin.projectId, gameVersion)
      if (!compatibleInstall) {
        throw new Error(`${plugin.name} has no compatible Fabric release for Minecraft ${gameVersion}.`)
      }

      modVersion = compatibleInstall.version
      const installPlan = compatibleInstall.installPlan
      fabricVersionId = await installFabricProfile(gameVersion)
      const directory = modsDirectory(settings.gameDir)
      await mkdir(directory, { recursive: true })
      const filesToInstall = installPlan.filter((version) => {
        if (version.projectId === plugin.projectId && installedPluginMods.length > 0) return false
        const installed = installedMods.find((mod) => mod.name === version.file.filename)
        return !installed || !installed.enabled
      })
      for (const version of filesToInstall) {
        await downloadModrinthFile(version.file, directory)
      }
      await setInstalledPluginMods(settings.gameDir, installedMods, plugin, true)
    } else {
      await setInstalledPluginMods(settings.gameDir, installedMods, plugin, false)
    }

    const updatedMods = await listMods(settings.gameDir)
    const updatedPluginMods = pluginMods(plugin, updatedMods)
    return {
      id: plugin.id,
      installed: updatedPluginMods.length > 0,
      enabled: updatedPluginMods.some((mod) => mod.enabled),
      version: modVersion?.version,
      fabricVersionId
    }
  } finally {
    modOperationInProgress = false
  }
}

async function launchMinecraft(value: unknown, selectedWorld: unknown): Promise<void> {
  if (!player || !minecraftSession) throw new Error('Sign in with a Microsoft account that owns Minecraft Java Edition before launching.')
  if (minecraftProcess && !minecraftProcess.killed) throw new Error('Minecraft is already running.')
  if (launchInProgress) throw new Error('A Minecraft installation or launch is already in progress.')
  if (typeof value !== 'string') throw new Error('Invalid Minecraft version.')
  if (selectedWorld !== undefined &&
      (typeof selectedWorld !== 'string' || selectedWorld.length > 255 ||
       selectedWorld === '.' || selectedWorld === '..' ||
       /[<>:"/\\|?*\u0000-\u001f]/.test(selectedWorld) || basename(selectedWorld) !== selectedWorld)) {
    throw new Error('Invalid world selection.')
  }
  const versionId = value

  launchInProgress = true
  try {
    const settings = await getSettings()
    let worldId: string | undefined
    if (typeof selectedWorld === 'string') {
      let saveEntries: Dirent<string>[]
      try {
        saveEntries = await readdir(worldsDirectory(settings.gameDir), { withFileTypes: true })
      } catch (error) {
        if (isMissingFile(error)) throw new Error('The selected world is no longer available in the saves folder.')
        throw error
      }
      if (!saveEntries.some((entry) => entry.isDirectory() && entry.name === selectedWorld)) {
        throw new Error('The selected world is no longer available in the saves folder.')
      }
      const levelData = await readOptionalFile(join(worldsDirectory(settings.gameDir), selectedWorld, 'level.dat'))
      if (!levelData) throw new Error('The selected folder is no longer a valid Minecraft world.')
      try {
        parseWorldMetadata(levelData)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Invalid world metadata.'
        throw new Error(`Could not load world "${selectedWorld}": ${reason}`)
      }
      worldId = selectedWorld
    }

    const manifest = await getVersionManifest()
    const selection = getLaunchBaseVersion(versionId, getSupportedReleases(manifest))
    if (!selection) throw new Error(`Minecraft version ${versionId} is unavailable or not supported by this launcher.`)
    const { version, isFabric } = selection

    const metadataValue = await fetchJson(version.url, `Minecraft ${versionId} metadata`)
    if (typeof metadataValue !== 'object' || metadataValue === null ||
        !('id' in metadataValue) || metadataValue.id !== version.id ||
        !('javaVersion' in metadataValue) || typeof metadataValue.javaVersion !== 'object' ||
        metadataValue.javaVersion === null || !('majorVersion' in metadataValue.javaVersion) ||
        typeof metadataValue.javaVersion.majorVersion !== 'number' ||
        !Number.isInteger(metadataValue.javaVersion.majorVersion)) {
      throw new Error(`Mojang did not provide a valid Java requirement for Minecraft ${versionId}.`)
    }
    const requiredJava = metadataValue.javaVersion.majorVersion
    await checkJava(settings.javaPath, requiredJava, versionId)
    await refreshMinecraftSessionIfNeeded()

    await mkdir(settings.gameDir, { recursive: true })
    const installerVersion: MinecraftVersionBaseInfo = { id: version.id, url: version.url }
    const task = installTask(installerVersion, settings.gameDir, { throwErrorImmediately: true })
    emit({ type: 'status', message: `Preparing Minecraft ${versionId}…` })
    const vanillaVersion = await task.startAndWait({
      onStart: (childTask) => emit({ type: 'status', message: childTask.name || 'Preparing game files…' }),
      onUpdate: (childTask) => {
        const percent = childTask.total > 0
          ? Math.max(0, Math.min(100, Math.round(childTask.progress / childTask.total * 100)))
          : undefined
        emit({ type: 'progress', message: childTask.name || 'Downloading game files…', percent })
      }
    })

    const resolvedVersion = isFabric
      ? await CoreVersion.parse(settings.gameDir, versionId)
      : vanillaVersion
    if (resolvedVersion.minecraftVersion !== version.id) {
      throw new Error(`Installed mod-loader profile ${versionId} does not match Minecraft ${version.id}.`)
    }
    await checkJava(settings.javaPath, resolvedVersion.javaVersion.majorVersion, versionId)
    await refreshMinecraftSessionIfNeeded()
    const sessionState = minecraftSession
    if (!sessionState) throw new Error('Sign in with Microsoft before launching.')
    const child = await launch({
      accessToken: sessionState.accessToken,
      gameProfile: { id: sessionState.player.uuid, name: sessionState.player.name },
      gamePath: settings.gameDir,
      resourcePath: settings.gameDir,
      javaPath: settings.javaPath || 'java',
      version: resolvedVersion,
      minMemory: settings.minRam,
      maxMemory: settings.maxRam,
      resolution: { width: settings.width, height: settings.height, fullscreen: false },
      extraJVMArgs: parseJavaArgs(settings.javaArgs),
      extraMCArgs: worldId ? ['--quickPlaySingleplayer', worldId] : undefined
    })

    minecraftProcess = child
    let processFinished = false
    child.once('error', () => {
      if (processFinished) return
      processFinished = true
      minecraftProcess = null
      emit({ type: 'error', message: 'Minecraft could not start. Check the Java executable and launcher status.' })
    })
    child.once('close', (code, signal) => {
      if (processFinished) return
      processFinished = true
      minecraftProcess = null
      emit({
        type: 'closed',
        message: code === 0
          ? 'Minecraft closed.'
          : `Minecraft closed with exit code ${code ?? signal ?? 'unknown'}.`
      })
    })
    emit({ type: 'status', message: `Minecraft ${versionId} started.` })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Minecraft could not be launched.'
    emit({ type: 'error', message })
    throw error
  } finally {
    launchInProgress = false
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('versions:list', async (event) => {
    validateIpcSender(event)
    const manifest = await getVersionManifest()
    const settings = await getSettings()
    return getLauncherVersions(manifest, settings.gameDir)
  })

  ipcMain.handle('settings:get', (event) => {
    validateIpcSender(event)
    return getSettings()
  })

  ipcMain.handle('settings:save', async (event, value: unknown) => {
    validateIpcSender(event)
    const settings = normalizeSettings(value)
    await atomicWrite(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  })

  ipcMain.handle('directory:choose', async (event) => {
    validateIpcSender(event)
    const window = mainWindow
    if (!window || window.isDestroyed()) throw new Error('The launcher window is not available.')
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('mods:list', (event) => {
    validateIpcSender(event)
    return getSettings().then((settings) => listMods(settings.gameDir))
  })

  ipcMain.handle('mods:add', async (event) => {
    validateIpcSender(event)
    if (modOperationInProgress) throw new Error('A mod file operation is already in progress.')
    modOperationInProgress = true
    try {
      const window = mainWindow
      if (!window || window.isDestroyed()) throw new Error('The launcher window is not available.')
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Minecraft mod (.jar)', extensions: ['jar'] }]
      })
      if (result.canceled || !result.filePaths[0]) return listMods((await getSettings()).gameDir)

      const settings = await getSettings()
      const source = result.filePaths[0]
      const name = validateModName(basename(source))
      const directory = modsDirectory(settings.gameDir)
      await mkdir(directory, { recursive: true })
      try {
        await copyFile(source, join(directory, name), constants.COPYFILE_EXCL)
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
          throw new Error(`${name} is already in the Mods folder.`)
        }
        throw error
      }
      return listMods(settings.gameDir)
    } finally {
      modOperationInProgress = false
    }
  })

  ipcMain.handle('mods:enabled', async (event, value: unknown, enabled: unknown) => {
    validateIpcSender(event)
    if (typeof enabled !== 'boolean') throw new Error('Invalid mod enabled state.')
    if (modOperationInProgress) throw new Error('A mod file operation is already in progress.')
    modOperationInProgress = true
    try {
      const settings = await getSettings()
      const name = validateModName(value)
      const mods = await listMods(settings.gameDir)
      const mod = mods.find((item) => item.name === name)
      if (!mod) throw new Error(`${name} is not in the Mods folder.`)
      if (mod.enabled === enabled) return mods

      const directory = modsDirectory(settings.gameDir)
      const source = join(directory, mod.enabled ? name : `${name}.disabled`)
      const destination = join(directory, enabled ? name : `${name}.disabled`)
      await ensurePathDoesNotExist(destination)
      await rename(source, destination)
      return listMods(settings.gameDir)
    } finally {
      modOperationInProgress = false
    }
  })

  ipcMain.handle('mods:open-folder', async (event) => {
    validateIpcSender(event)
    const settings = await getSettings()
    const directory = modsDirectory(settings.gameDir)
    await mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(`Could not open the Mods folder: ${error}`)
  })

  ipcMain.handle('plugins:list', async (event, gameVersion: unknown) => {
    validateIpcSender(event)
    if (typeof gameVersion !== 'string' || !isSupportedRelease(gameVersion)) {
      throw new Error('Choose a supported Minecraft release to view compatible plugins.')
    }
    const settings = await getSettings()
    return listPlugins(settings.gameDir, gameVersion)
  })

  ipcMain.handle('plugins:enabled', async (event, id: unknown, enabled: unknown, gameVersion: unknown) => {
    validateIpcSender(event)
    return setPluginEnabled(id, enabled, gameVersion)
  })

  ipcMain.handle('worlds:list', async (event) => {
    validateIpcSender(event)
    const settings = await getSettings()
    return listWorlds(settings.gameDir)
  })

  ipcMain.handle('worlds:open-folder', async (event) => {
    validateIpcSender(event)
    const settings = await getSettings()
    const directory = worldsDirectory(settings.gameDir)
    await mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(`Could not open the Worlds folder: ${error}`)
  })

  ipcMain.handle('mods:fabric-install', async (event, version: unknown) => {
    validateIpcSender(event)
    return installFabricProfile(version)
  })

  ipcMain.handle('auth:login', async (event) => {
    validateIpcSender(event)
    if (authOperationInProgress) throw new Error('A Microsoft account operation is already in progress.')
    authOperationInProgress = true
    try {
      const client = createAuthClient()
      const result = await client.acquireTokenInteractive({
        scopes: MINECRAFT_SCOPES,
        prompt: 'select_account',
        openBrowser: async (authorizationUrl) => {
          const url = new URL(authorizationUrl)
          if (url.protocol !== 'https:' ||
              !['login.microsoftonline.com', 'login.live.com'].includes(url.hostname)) {
            throw new Error('Microsoft sign-in returned an untrusted authorization URL.')
          }
          await shell.openExternal(url.href)
        }
      })
      if (!result.account || !result.accessToken) throw new Error('Microsoft sign-in did not return an account session.')

      try {
        const authenticated = await authenticateMinecraft(result.accessToken, result.account)
        const accounts = await client.getAllAccounts()
        for (const account of accounts) {
          if (account.homeAccountId !== result.account.homeAccountId) {
            await client.getTokenCache().removeAccount(account)
          }
        }
        minecraftSession = authenticated
        player = authenticated.player
        restoreError = null
        return player
      } catch (error) {
        if (error instanceof NoJavaOwnershipError) {
          await client.getTokenCache().removeAccount(result.account)
        }
        throw error
      }
    } finally {
      authOperationInProgress = false
    }
  })

  ipcMain.handle('auth:player', (event) => {
    validateIpcSender(event)
    if (restoreError) throw new Error(restoreError)
    return player
  })

  ipcMain.handle('auth:cape', async (event, value: unknown) => {
    validateIpcSender(event)
    if (value !== null && typeof value !== 'string') throw new Error('Invalid cape selection.')
    if (!minecraftSession || !player) throw new Error('Sign in before managing capes.')
    if (authOperationInProgress) throw new Error('A Microsoft account operation is already in progress.')
    if (typeof value === 'string' && !player.capes.some((cape) => cape.id === value)) {
      throw new Error('That cape is not available on this Minecraft profile.')
    }

    authOperationInProgress = true
    try {
      await refreshMinecraftSessionIfNeeded()
      const current = minecraftSession
      if (!current) throw new Error('Sign in before managing capes.')
      const mojang = new MojangClient()
      const profile = value === null
        ? await mojang.hideCape(current.accessToken).then(() => mojang.getProfile(current.accessToken))
        : await mojang.showCape(value, current.accessToken)
      current.player = parseMinecraftProfile(profile)
      player = current.player
      return player
    } finally {
      authOperationInProgress = false
    }
  })

  ipcMain.handle('auth:logout', async (event) => {
    validateIpcSender(event)
    if (authOperationInProgress) throw new Error('A Microsoft account operation is already in progress.')
    authOperationInProgress = true
    try {
      if (isValidMicrosoftClientId(MICROSOFT_OAUTH_CLIENT_ID)) {
        const cachePath = getAuthCachePath()
        try {
          await unlink(cachePath)
        } catch (error) {
          if (!isMissingFile(error)) throw error
        }
      }
      player = null
      minecraftSession = null
      restoreError = null
    } finally {
      authOperationInProgress = false
    }
  })

  ipcMain.handle('game:launch', async (event, version: unknown, worldId: unknown) => {
    validateIpcSender(event)
    await launchMinecraft(version, worldId)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    await migrateLegacyData()
    await mkdir(DATA_DIR, { recursive: true })
    configureContentSecurityPolicy()
    await restoreSession()
    registerIpcHandlers()
    await createWindow()
  }).catch((error: unknown) => {
    dialog.showErrorBox(
      'LightingClient could not start',
      error instanceof Error ? error.message : 'An unexpected startup error occurred.'
    )
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error: unknown) => {
        dialog.showErrorBox(
          'LightingClient could not open',
          error instanceof Error ? error.message : 'An unexpected window error occurred.'
        )
      })
    }
  })
}

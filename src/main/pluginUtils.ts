export type PluginDefinition = {
  id: string
  projectId: string
  name: string
  description: string
  filenameMatches: string[]
}

export type ModrinthDependency = {
  projectId?: string
  versionId?: string
}

export type ModrinthFile = {
  filename: string
  url: string
  size: number
  sha512: string
}

export type ModrinthVersion = {
  id: string
  projectId: string
  version: string
  publishedAt: number
  dependencies: ModrinthDependency[]
  file: ModrinthFile
}

export class UnsupportedModrinthDependencyError extends Error {}

export async function resolveFirstInstallableModrinthVersion(
  versions: ModrinthVersion[],
  resolveInstallPlan: (version: ModrinthVersion) => Promise<ModrinthVersion[]>
): Promise<{ version: ModrinthVersion; installPlan: ModrinthVersion[] } | undefined> {
  let dependencyError: UnsupportedModrinthDependencyError | undefined
  for (const version of versions) {
    try {
      return { version, installPlan: await resolveInstallPlan(version) }
    } catch (error) {
      if (!(error instanceof UnsupportedModrinthDependencyError)) throw error
      dependencyError = error
    }
  }
  if (dependencyError) {
    throw new Error(`No compatible version has installable dependencies: ${dependencyError.message}`)
  }
  return undefined
}

export const PLUGIN_CATALOG: PluginDefinition[] = [
  {
    id: 'tool-durability',
    projectId: 'hAG5PWoN',
    name: 'Tool Durability HUD',
    description: 'Shows armor and tool durability on screen.',
    filenameMatches: ['armorhud', 'mc-armor-hud']
  },
  {
    id: 'appleskin',
    projectId: 'EsAfCjCV',
    name: 'AppleSkin',
    description: 'Displays hunger and saturation information.',
    filenameMatches: ['appleskin']
  },
  {
    id: 'betterf3',
    projectId: '8shC1gFX',
    name: 'BetterF3',
    description: 'Replaces the debug screen with a customizable layout.',
    filenameMatches: ['betterf3']
  },
  {
    id: 'effect-timer',
    projectId: 'kBpn4X5r',
    name: 'Effect Timer (DuraHUD)',
    description: 'Shows active-effect timers and configurable HUD widgets.',
    filenameMatches: ['durahud']
  },
  {
    id: 'minihud',
    projectId: 'UMxybHE8',
    name: 'MiniHUD',
    description: 'Adds configurable HUD information such as coordinates and FPS.',
    filenameMatches: ['minihud']
  },
  {
    id: 'shulker-tooltip',
    projectId: '2M01OLQq',
    name: 'Shulker Box Tooltip',
    description: 'Previews shulker-box contents from your inventory.',
    filenameMatches: ['shulkerboxtooltip']
  },
  {
    id: 'zoomify',
    projectId: 'w7ThoJFB',
    name: 'Zoomify',
    description: 'Adds a configurable zoom keybind.',
    filenameMatches: ['zoomify']
  }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeModrinthId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function parseModrinthVersion(
  value: unknown,
  projectId: string,
  gameVersion: string
): ModrinthVersion | undefined {
  if (!isRecord(value) ||
      value.project_id !== projectId ||
      !isSafeModrinthId(value.id) ||
      typeof value.version_number !== 'string' ||
      typeof value.date_published !== 'string' ||
      !Array.isArray(value.game_versions) ||
      !value.game_versions.includes(gameVersion) ||
      !Array.isArray(value.loaders) ||
      !value.loaders.includes('fabric') ||
      value.version_type !== 'release' ||
      value.status !== 'listed' ||
      !Array.isArray(value.dependencies) ||
      !Array.isArray(value.files)) {
    return undefined
  }

  const file = value.files.find((candidate) =>
    isRecord(candidate) && candidate.primary === true &&
    typeof candidate.filename === 'string' && candidate.filename.toLowerCase().endsWith('.jar')
  ) ?? value.files.find((candidate) =>
    isRecord(candidate) && typeof candidate.filename === 'string' &&
    candidate.filename.toLowerCase().endsWith('.jar')
  )
  if (!isRecord(file) ||
      typeof file.filename !== 'string' ||
      file.filename.length > 255 ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(file.filename) ||
      typeof file.url !== 'string' ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 100 * 1024 * 1024 ||
      !isRecord(file.hashes) ||
      typeof file.hashes.sha512 !== 'string' ||
      !/^[0-9a-f]{128}$/i.test(file.hashes.sha512)) {
    return undefined
  }

  let downloadUrl: URL
  try {
    downloadUrl = new URL(file.url)
  } catch {
    return undefined
  }
  if (downloadUrl.protocol !== 'https:' ||
      downloadUrl.hostname !== 'cdn.modrinth.com' ||
      downloadUrl.username || downloadUrl.password) {
    return undefined
  }

  const publishedAt = Date.parse(value.date_published)
  if (!Number.isFinite(publishedAt)) return undefined

  const dependencies: ModrinthDependency[] = []
  for (const dependency of value.dependencies) {
    if (!isRecord(dependency) || dependency.dependency_type !== 'required') continue
    const projectDependency = isSafeModrinthId(dependency.project_id) ? dependency.project_id : undefined
    const versionDependency = isSafeModrinthId(dependency.version_id) ? dependency.version_id : undefined
    if (!projectDependency && !versionDependency) return undefined
    dependencies.push({ projectId: projectDependency, versionId: versionDependency })
  }

  return {
    id: value.id,
    projectId,
    version: value.version_number,
    publishedAt,
    dependencies,
    file: {
      filename: file.filename,
      url: downloadUrl.href,
      size: file.size,
      sha512: file.hashes.sha512.toLowerCase()
    }
  }
}

export function listCompatibleModrinthVersions(
  value: unknown,
  projectId: string,
  gameVersion: string
): ModrinthVersion[] {
  if (!Array.isArray(value)) throw new Error('Modrinth returned an invalid version list.')
  return value
    .map((candidate) => parseModrinthVersion(candidate, projectId, gameVersion))
    .filter((version): version is ModrinthVersion => version !== undefined)
    .sort((left, right) => right.publishedAt - left.publishedAt)
}

export function selectModrinthVersion(
  value: unknown,
  projectId: string,
  gameVersion: string
): ModrinthVersion | undefined {
  return listCompatibleModrinthVersions(value, projectId, gameVersion)[0]
}

export function parsePinnedModrinthVersion(
  value: unknown,
  projectId: string,
  gameVersion: string
): ModrinthVersion {
  const version = parseModrinthVersion(value, projectId, gameVersion)
  if (!version) throw new Error('A required Modrinth dependency is not compatible with this Minecraft version.')
  return version
}

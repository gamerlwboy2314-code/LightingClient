export type LauncherSettings = {
  gameDir: string
  minRam: number
  maxRam: number
  javaPath: string
  javaArgs: string
  width: number
  height: number
  theme: 'dark' | 'light'
}
export type Player = { name: string; uuid: string; skins: Skin[]; capes: Cape[] }
export type LaunchEvent = { type: 'progress' | 'status' | 'error' | 'closed'; message: string; percent?: number }
export type Skin = { id: string; name: string; url: string | null; state: string }
export type Cape = { id: string; name: string; url: string | null; active: boolean }
export type ModInfo = { name: string; enabled: boolean }
export type WorldInfo = {
  id: string
  name: string
  createdAt: string | null
  lastPlayed: string | null
  gameMode: string
  icon: string | null
}
export type PluginInfo = {
  id: string
  name: string
  description: string
  installed: boolean
  enabled: boolean
  supported: boolean
  version: string | null
}
export type PluginUpdate = {
  id: string
  installed: boolean
  enabled: boolean
  version?: string
  fabricVersionId?: string
}
export type VersionInfo = { id: string; type: string; baseVersion?: string }
export interface LauncherAPI {
  getVersions(): Promise<VersionInfo[]>
  getSettings(): Promise<LauncherSettings>
  saveSettings(settings: LauncherSettings): Promise<void>
  chooseDirectory(): Promise<string | null>
  getMods(): Promise<ModInfo[]>
  addMod(): Promise<ModInfo[]>
  setModEnabled(name: string, enabled: boolean): Promise<ModInfo[]>
  openModsFolder(): Promise<void>
  getWorlds(): Promise<WorldInfo[]>
  openWorldsFolder(): Promise<void>
  getPlugins(gameVersion: string): Promise<PluginInfo[]>
  setPluginEnabled(id: string, enabled: boolean, gameVersion: string): Promise<PluginUpdate>
  installFabric(version: string): Promise<string>
  login(): Promise<Player>
  logout(): Promise<void>
  getPlayer(): Promise<Player | null>
  setCape(capeId: string | null): Promise<Player>
  launch(version: string, worldId?: string): Promise<void>
  onLaunchEvent(callback: (event: LaunchEvent) => void): () => void
}

import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherAPI, LaunchEvent, LauncherSettings, Player } from '../shared/types'

const api: LauncherAPI = {
  getVersions: () => ipcRenderer.invoke('versions:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: LauncherSettings) => ipcRenderer.invoke('settings:save', s),
  chooseDirectory: () => ipcRenderer.invoke('directory:choose'),
  getMods: () => ipcRenderer.invoke('mods:list'),
  addMod: () => ipcRenderer.invoke('mods:add'),
  setModEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('mods:enabled', name, enabled),
  openModsFolder: () => ipcRenderer.invoke('mods:open-folder'),
  getWorlds: () => ipcRenderer.invoke('worlds:list'),
  openWorldsFolder: () => ipcRenderer.invoke('worlds:open-folder'),
  getPlugins: (gameVersion: string) => ipcRenderer.invoke('plugins:list', gameVersion),
  setPluginEnabled: (id: string, enabled: boolean, gameVersion: string) =>
    ipcRenderer.invoke('plugins:enabled', id, enabled, gameVersion),
  installFabric: (version: string) => ipcRenderer.invoke('mods:fabric-install', version),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getPlayer: () => ipcRenderer.invoke('auth:player'),
  setCape: (capeId: string | null) => ipcRenderer.invoke('auth:cape', capeId),
  launch: (version: string, worldId?: string) => ipcRenderer.invoke('game:launch', version, worldId),
  onLaunchEvent: (callback: (event: LaunchEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: LaunchEvent) => callback(data)
    ipcRenderer.on('launcher:event', listener)
    return () => ipcRenderer.removeListener('launcher:event', listener)
  }
}
contextBridge.exposeInMainWorld('launcher', api)

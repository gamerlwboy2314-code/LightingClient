import { useEffect, useState } from 'react'
import type { LauncherSettings, LauncherUpdateStatus, ModInfo, Player, PluginInfo, VersionInfo, LaunchEvent, WorldInfo } from '../../shared/types'
import lightningIcon from './assets/lightning-icon.png'

type Page = 'play' | 'mods' | 'plugins' | 'worlds' | 'capes' | 'settings' | 'dev'

const initial: LauncherSettings = {
  gameDir: '',
  minRam: 2,
  maxRam: 6,
  javaPath: '',
  javaArgs: '',
  width: 1280,
  height: 720,
  theme: 'dark'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function LightningBackdrop() {
  return <svg className="lightning-backdrop" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <path className="lightning-strike strike-left" pathLength={1} d="M410 -70 300 145 380 145 220 355 275 190 190 190 255 -70"/>
    <path className="lightning-strike strike-center" pathLength={1} d="M930 -90 780 165 870 165 655 455 720 230 625 230 755 -90"/>
    <path className="lightning-strike strike-right" pathLength={1} d="M1370 80 1280 245 1340 245 1190 440 1235 285 1170 285 1225 80"/>
  </svg>
}

export default function App() {
  const [page, setPage] = useState<Page>('play')
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [version, setVersion] = useState('')
  const [baseVersion, setBaseVersion] = useState('')
  const [mods, setMods] = useState<ModInfo[]>([])
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [worlds, setWorlds] = useState<WorldInfo[]>([])
  const [worldsLoading, setWorldsLoading] = useState(false)
  const [settings, setSettings] = useState(initial)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [startupDelayElapsed, setStartupDelayElapsed] = useState(false)
  const [player, setPlayer] = useState<Player | null>(null)
  const [appVersion, setAppVersion] = useState('1.0.2')
  const [updateStatus, setUpdateStatus] = useState<LauncherUpdateStatus>({ status: 'idle' })
  const [event, setEvent] = useState<LaunchEvent>({ type: 'status', message: 'Ready when you are.' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const timeout = window.setTimeout(() => setStartupDelayElapsed(true), 1800)
    return () => window.clearTimeout(timeout)
  }, [])

  useEffect(() => {
    const unsubscribe = window.launcher.onUpdateEvent(setUpdateStatus)
    window.launcher.getUpdateStatus()
      .then(setUpdateStatus)
      .catch((e: unknown) => setError(messageOf(e)))
    window.launcher.getAppVersion()
      .then(setAppVersion)
      .catch((e: unknown) => setError(messageOf(e)))
    return unsubscribe
  }, [])

  useEffect(() => {
    window.launcher.getSettings()
      .then(setSettings)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setSettingsLoaded(true))
    window.launcher.getVersions()
      .then((items) => {
        setVersions(items)
        const release = items.find((item) => item.type === 'release')
        if (release) {
          setVersion(release.id)
          setBaseVersion(release.id)
        }
      })
      .catch((e: unknown) => setError(`Could not load Minecraft versions: ${messageOf(e)}`))
    window.launcher.getPlayer()
      .then(setPlayer)
      .catch((e: unknown) => setError(messageOf(e)))
    return window.launcher.onLaunchEvent(setEvent)
  }, [])

  useEffect(() => {
    if (page !== 'mods' || !settingsLoaded) return
    window.launcher.getMods().then(setMods).catch((e: unknown) => setError(messageOf(e)))
  }, [page, settingsLoaded])

  useEffect(() => {
    if (page !== 'worlds' || !settingsLoaded) return
    setWorldsLoading(true)
    window.launcher.getWorlds()
      .then(setWorlds)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setWorldsLoading(false))
  }, [page, settingsLoaded])

  const selectedGameVersion = versions.find((item) => item.id === version)?.baseVersion || version

  useEffect(() => {
    if (page !== 'plugins' || !settingsLoaded || !selectedGameVersion) return
    setPluginsLoading(true)
    window.launcher.getPlugins(selectedGameVersion)
      .then(setPlugins)
      .catch((e: unknown) => setError(`Could not load compatible plugins: ${messageOf(e)}`))
      .finally(() => setPluginsLoading(false))
  }, [page, settingsLoaded, selectedGameVersion])

  const update = <K extends keyof LauncherSettings>(key: K, value: LauncherSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }))
  const releaseVersions = versions.filter((item) => item.type === 'release')

  async function signInMicrosoft() {
    setBusy(true)
    setError('')
    try {
      await window.launcher.saveSettings(settings)
      setPlayer(await window.launcher.login())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function launchGame() {
    setBusy(true)
    setError('')
    try {
      await window.launcher.saveSettings(settings)
      await window.launcher.launch(version)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function launchWorld(world: WorldInfo) {
    if (busy) return
    if (!player) {
      setError('Sign in with Microsoft before launching a world.')
      return
    }
    if (!version) {
      setError('Choose a Minecraft version before launching a world.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await window.launcher.saveSettings(settings)
      await window.launcher.launch(version, world.id)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings() {
    setBusy(true)
    setError('')
    try {
      await window.launcher.saveSettings(settings)
      setEvent({ type: 'status', message: 'Settings saved.' })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function chooseDirectory() {
    setBusy(true)
    setError('')
    try {
      const path = await window.launcher.chooseDirectory()
      if (path) update('gameDir', path)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setError('')
    try {
      await window.launcher.logout()
      setPlayer(null)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function addMod() {
    setBusy(true)
    setError('')
    try {
      setMods(await window.launcher.addMod())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleMod(mod: ModInfo) {
    setBusy(true)
    setError('')
    try {
      setMods(await window.launcher.setModEnabled(mod.name, !mod.enabled))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function togglePlugin(plugin: PluginInfo, enabled: boolean) {
    if (!selectedGameVersion) return
    setBusy(true)
    setError('')
    try {
      await window.launcher.saveSettings(settings)
      const result = await window.launcher.setPluginEnabled(plugin.id, enabled, selectedGameVersion)
      setPlugins((current) => current.map((item) => item.id === result.id
        ? {
            ...item,
            installed: result.installed,
            enabled: result.enabled,
            version: result.version ?? item.version
          }
        : item))
      if (result.fabricVersionId) {
        setVersions(await window.launcher.getVersions())
        setVersion(result.fabricVersionId)
        setBaseVersion(selectedGameVersion)
        setEvent({ type: 'status', message: `${plugin.name} is ready. Restart Minecraft to load it.` })
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function refreshPlugins() {
    if (!selectedGameVersion) return
    setPluginsLoading(true)
    setError('')
    try {
      setPlugins(await window.launcher.getPlugins(selectedGameVersion))
    } catch (e) {
      setError(`Could not load compatible plugins: ${messageOf(e)}`)
    } finally {
      setPluginsLoading(false)
    }
  }

  async function installFabric() {
    setBusy(true)
    setError('')
    try {
      const profileId = await window.launcher.installFabric(baseVersion)
      const updatedVersions = await window.launcher.getVersions()
      setVersions(updatedVersions)
      setVersion(profileId)
      setEvent({ type: 'status', message: `Fabric is ready for Minecraft ${baseVersion}.` })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function openModsFolder() {
    setError('')
    try {
      await window.launcher.openModsFolder()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function openWorldsFolder() {
    setError('')
    try {
      await window.launcher.openWorldsFolder()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function refreshWorlds() {
    setWorldsLoading(true)
    setError('')
    try {
      setWorlds(await window.launcher.getWorlds())
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setWorldsLoading(false)
    }
  }

  async function setCape(capeId: string | null) {
    setBusy(true)
    setError('')
    try {
      setPlayer(await window.launcher.setCape(capeId))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function checkForUpdates() {
    try {
      await window.launcher.checkForUpdates()
    } catch (e) {
      setUpdateStatus({ status: 'error', message: messageOf(e) })
    }
  }

  async function downloadUpdate() {
    try {
      await window.launcher.downloadUpdate()
    } catch (e) {
      setUpdateStatus({ status: 'error', message: messageOf(e) })
    }
  }

  async function installUpdate() {
    try {
      await window.launcher.installUpdate()
    } catch (e) {
      setUpdateStatus({ status: 'error', message: messageOf(e) })
    }
  }

  async function openReleaseManager() {
    try {
      await window.launcher.openReleaseManager()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const headings: Record<Page, string> = {
    play: 'Your next adventure.',
    mods: 'Manage your mods.',
    plugins: 'Your installed plugins.',
    worlds: 'Your Minecraft worlds.',
    capes: 'Your profile cosmetics.',
    settings: 'Launcher settings.',
    dev: 'Developer Centre.'
  }

  if (!settingsLoaded || !startupDelayElapsed) {
    return <main className="startup-screen" aria-busy="true">
      <LightningBackdrop/>
      <div className="startup-orb startup-orb-left" aria-hidden="true"/>
      <div className="startup-orb startup-orb-right" aria-hidden="true"/>
      <section className="startup-content" role="status" aria-live="polite">
        <div className="startup-mark"><img src={lightningIcon} alt=""/></div>
        <p className="startup-brand">LIGHTINGCLIENT</p>
        <h1>Loading your launcher</h1>
        <p className="startup-copy">Getting everything ready for your next adventure.</p>
        <div className="loading-track" aria-hidden="true"><span/></div>
        <span className="startup-caption">MINECRAFT JAVA EDITION</span>
      </section>
    </main>
  }

  return <main className={settings.theme}>
    <LightningBackdrop/>
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-icon" src={lightningIcon} alt=""/>
        <div><b>LightingClient</b><small>MINECRAFT JAVA LAUNCHER</small></div>
      </div>
      <nav aria-label="Launcher sections">
        {([
          ['play', '▶', 'Play'],
          ['mods', '▦', 'Mods'],
          ['plugins', '⬡', 'Plugins'],
          ['worlds', '◈', 'Worlds'],
          ['capes', '✦', 'Skins & Capes'],
          ['settings', '⚙', 'Settings']
        ] as const).map(([id, icon, label]) =>
          <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}>
            {icon}<span>{label}</span>
          </button>
        )}
      </nav>
      <div className="side-bottom"><span className="dot"/><small>LightingClient · v{appVersion}</small></div>
    </aside>

    <section className="content">
      <header>
        <div><div className="eyebrow">MINECRAFT JAVA EDITION</div><h1>{headings[page]}</h1></div>
        {player
          ? <div className="profile"><div className="avatar">{player.name.slice(0, 1).toUpperCase()}</div><span>{player.name}</span><button className="quiet" onClick={signOut} disabled={busy}>Sign out</button></div>
          : <button className="outline" onClick={signInMicrosoft} disabled={busy || !settingsLoaded}>
            {!settingsLoaded ? 'Loading…' : 'Sign in with Microsoft'}
          </button>}
      </header>

      {updateStatus.status === 'available' && <div className="update-banner page-enter" role="status">
        <div className="update-copy">
          <span className="eyebrow">UPDATE AVAILABLE · VERSION {updateStatus.version}</span>
          <b>{updateStatus.title}</b>
          {updateStatus.notes && <p>{updateStatus.notes}</p>}
        </div>
        <button className="play compact" onClick={downloadUpdate}>DOWNLOAD UPDATE</button>
      </div>}
      {updateStatus.status === 'downloading' && <div className="update-banner" role="status">
        <div className="update-copy"><span className="eyebrow">DOWNLOADING VERSION {updateStatus.version}</span><b>{updateStatus.percent}%</b></div>
        <div className="progress update-progress"><span style={{ width: `${updateStatus.percent}%` }}/></div>
      </div>}
      {updateStatus.status === 'downloaded' && <div className="update-banner page-enter" role="status">
        <div className="update-copy"><span className="eyebrow">UPDATE READY · VERSION {updateStatus.version}</span><b>{updateStatus.title}</b></div>
        <button className="play compact" onClick={installUpdate}>RESTART TO UPDATE</button>
      </div>}
      {updateStatus.status === 'error' && <div className="update-banner update-warning" role="status">
        <div className="update-copy"><span className="eyebrow">UPDATE CHECK</span><p>{updateStatus.message}</p></div>
        <button className="outline" onClick={checkForUpdates}>RETRY</button>
      </div>}

      {page === 'play' && <div className="page-enter">
        <div className="hero">
          <div className="hero-copy">
            <span className="pill">JAVA EDITION · VANILLA & FABRIC</span>
            <h2>Ready when<br/><em>you are.</em></h2>
            <p>Pick a Minecraft version and start playing. Your worlds and settings stay on this computer.</p>
            <div className="launch-row">
              <label className="version-picker">Minecraft version
                <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions.length} aria-label="Minecraft version">
                  {!versions.length && <option value="">Loading versions…</option>}
                  {versions.map((item) =>
                    <option key={item.id} value={item.id}>
                      {item.type === 'fabric' ? `${item.baseVersion} · Fabric` : item.id}
                    </option>
                  )}
                </select>
              </label>
              <button className="play launch-button" onClick={launchGame} disabled={!player || !version || busy}>
                {busy ? 'WORKING…' : '▶  PLAY'}
              </button>
            </div>
            {!player && <small className="hint">Sign in with a Microsoft account that owns Minecraft Java Edition.</small>}
          </div>
        </div>
        <div className="lower-grid">
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">ACTIVITY</span><h3>Launcher status</h3></div><span className="status-tag"><i/> READY</span></div>
            <p className="status-message">{event.message}</p>
            {event.type === 'progress' && <div className="progress"><span style={{ width: `${event.percent ?? 0}%` }}/></div>}
          </div>
          <div className="panel news"><span className="eyebrow">QUICK TIP</span><h3>Want to use mods?</h3><p>Install Fabric in the Mods section, add compatible <code>.jar</code> files, then select the Fabric profile in the version list.</p></div>
        </div>
      </div>}

      {page === 'mods' && <div className="page-layout page-enter">
        <div className="panel">
          <div className="panel-head"><div><span className="eyebrow">MOD LOADER</span><h3>Fabric</h3></div></div>
          <p className="panel-copy">Install the latest stable Fabric loader for a Minecraft release. Select the new Fabric profile on the Play page to launch mods.</p>
          <div className="field-row loader-row">
            <label>Minecraft version
              <select value={baseVersion} onChange={(e) => setBaseVersion(e.target.value)} disabled={!releaseVersions.length}>
                {releaseVersions.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
            <button className="play" onClick={installFabric} disabled={!baseVersion || busy}>{busy ? 'WORKING…' : 'INSTALL FABRIC'}</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <div><span className="eyebrow">LOCAL MODS</span><h3>{mods.length} {mods.length === 1 ? 'mod' : 'mods'}</h3></div>
            <div className="panel-actions"><button className="outline" onClick={openModsFolder}>Open folder</button><button className="play compact" onClick={addMod} disabled={busy}>ADD MOD</button></div>
          </div>
          <p className="panel-copy">Add compatible Fabric <code>.jar</code> files. Mods can be enabled or disabled without deleting them.</p>
          {mods.length
            ? <div className="mod-list">{mods.map((mod) =>
              <div className="mod-row" key={mod.name}>
                <span className="mod-file">{mod.name}</span>
                <span className={`mod-state ${mod.enabled ? 'enabled' : ''}`}>{mod.enabled ? 'Enabled' : 'Disabled'}</span>
                <button className="quiet" onClick={() => toggleMod(mod)} disabled={busy}>{mod.enabled ? 'Disable' : 'Enable'}</button>
              </div>
            )}</div>
            : <p className="empty-state">No mods yet. Add a mod JAR or open the folder to manage files yourself.</p>}
        </div>
      </div>}

      {page === 'plugins' && <div className="panel page-enter">
        <div className="panel-head">
          <div><span className="eyebrow">FABRIC CLIENT MODS</span><h3>Plugins</h3></div>
          <button className="outline" onClick={refreshPlugins} disabled={pluginsLoading || !selectedGameVersion}>
            {pluginsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <p className="panel-copy">Switch on a plugin to install it from Modrinth with its required dependencies. Fabric is installed automatically; select the Fabric profile on Play and restart Minecraft to apply changes.</p>
        {!selectedGameVersion
          ? <p className="empty-state">Choose a Minecraft release to see compatible plugins.</p>
          : pluginsLoading
            ? <p className="empty-state">Checking Modrinth for compatible releases…</p>
            : <div className="plugin-list">{plugins.map((plugin) =>
              <div className="plugin-row" key={plugin.id}>
                <div className="plugin-copy">
                  <b>{plugin.name}</b>
                  <p>{plugin.description}</p>
                  <small>
                    {!plugin.supported
                      ? `No compatible Fabric release for Minecraft ${selectedGameVersion}.`
                      : plugin.installed
                        ? `${plugin.enabled ? 'Enabled' : 'Installed but disabled'}${plugin.version ? ` · v${plugin.version}` : ''}`
                        : 'Not installed · Enable to install'}
                  </small>
                </div>
                <label className="plugin-toggle">
                  <span>{plugin.enabled ? 'On' : 'Off'}</span>
                  <input
                    type="checkbox"
                    checked={plugin.enabled}
                    disabled={busy || (!plugin.supported && !(plugin.installed && plugin.enabled))}
                    onChange={(change) => { void togglePlugin(plugin, change.target.checked) }}
                    aria-label={`${plugin.enabled ? 'Disable' : 'Install and enable'} ${plugin.name}`}
                  />
                  <span className="toggle-track" aria-hidden="true"/>
                </label>
              </div>
            )}</div>}
      </div>}

      {page === 'worlds' && <div className="panel page-enter">
        <div className="panel-head">
          <div><span className="eyebrow">LOCAL SAVES</span><h3>{worlds.length} {worlds.length === 1 ? 'world' : 'worlds'}</h3></div>
          <div className="panel-actions">
            <button className="outline" onClick={refreshWorlds} disabled={worldsLoading}>{worldsLoading ? 'Loading…' : 'Refresh'}</button>
            <button className="play compact" onClick={openWorldsFolder}>IMPORT WORLDS</button>
          </div>
        </div>
        <p className="panel-copy">Worlds are read from the saves folder in your configured game directory. Copy an exported world folder there, then refresh the list.</p>
        {worldsLoading
          ? <p className="empty-state">Loading your worlds…</p>
          : worlds.length
            ? <div className="world-grid">{worlds.map((world) =>
              <article
                className={`world-card${!player || !version || busy ? ' world-card-disabled' : ''}`}
                key={world.id}
                role="button"
                tabIndex={0}
                aria-disabled={!player || !version || busy}
                aria-label={`Launch ${world.name} in Minecraft ${version}`}
                onClick={() => { void launchWorld(world) }}
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                    keyboardEvent.preventDefault()
                    void launchWorld(world)
                  }
                }}>
                {world.icon
                  ? <img className="world-icon" src={world.icon} alt={`${world.name} world preview`}/>
                  : <div className="world-icon world-icon-empty" aria-label="No world preview">◈</div>}
                <div className="world-details">
                  <h4 title={world.name}>{world.name}</h4>
                  <dl>
                    <div><dt>Game mode</dt><dd>{world.gameMode}</dd></div>
                    <div><dt>Created</dt><dd>{world.createdAt ? new Date(world.createdAt).toLocaleDateString() : 'Unknown'}</dd></div>
                    <div><dt>Last played</dt><dd>{world.lastPlayed ? new Date(world.lastPlayed).toLocaleString() : 'Never'}</dd></div>
                  </dl>
                  <span className="world-launch-label">{busy ? 'LAUNCHING…' : '▶  CLICK TO PLAY'}</span>
                </div>
              </article>
            )}</div>
            : <p className="empty-state">No worlds found. Import a world folder or create one in Minecraft, then refresh this list.</p>}
      </div>}

      {page === 'capes' && <div className="page-layout page-enter">
        <div className="panel">
          <span className="eyebrow">PROFILE COSMETICS</span>
          <h3>Skins & capes</h3>
          <p className="panel-copy">Preview the skins and capes available on this Minecraft Java profile. Applying or changing a cape requires a signed-in account.</p>
          {!player
            ? <p className="empty-state">No profile cosmetics are loaded. This launcher currently previews cosmetics from an existing Minecraft profile; it does not provide a public catalog or username lookup.</p>
            : <>
              {player.skins.length > 0 && <>
                <span className="eyebrow cosmetics-label">SKINS</span>
                <div className="cosmetic-grid">{player.skins.map((skin) =>
                  <article className="cosmetic-card" key={skin.id}>
                    {skin.url
                      ? <img className="skin-preview" src={skin.url} alt={`${skin.name} texture`}/>
                      : <div className="cosmetic-placeholder" aria-hidden="true">✦</div>}
                    <div className="cosmetic-meta"><b>{skin.name}</b><small>{skin.state === 'ACTIVE' ? 'Currently equipped' : skin.state}</small></div>
                  </article>
                )}</div>
              </>}
              <span className="eyebrow cosmetics-label">CAPES</span>
              {player.capes.length
                ? <div className="cape-list">{player.capes.map((cape) =>
                <div className="cape-row" key={cape.id}>
                  {cape.url
                    ? <img className="cape-preview" src={cape.url} alt={`${cape.name} preview`}/>
                    : <div className="cape-preview cape-placeholder" aria-hidden="true">✦</div>}
                  <div><b>{cape.name}</b><small>{cape.active ? 'Currently equipped' : 'Available'}</small></div>
                  {cape.active
                    ? <button className="outline" onClick={() => setCape(null)} disabled={busy}>Hide cape</button>
                    : <button className="play compact" onClick={() => setCape(cape.id)} disabled={busy}>EQUIP</button>}
                </div>
              )}</div>
                : <p className="empty-state">No capes are available on this Minecraft profile.</p>}
              {player.skins.length === 0 && <p className="empty-state">No skins are available on this Minecraft profile.</p>}
            </>}
        </div>
      </div>}

      {page === 'settings' && <div className="settings-layout page-enter">
        <div className="panel settings-panel">
          <span className="eyebrow">GAME CONFIGURATION</span><h3>Memory & Java</h3>
          <div className="field-row">
            <label>Minimum RAM (GB)<input type="number" min="1" max="64" value={settings.minRam} onChange={(e) => update('minRam', Number(e.target.value))}/></label>
            <label>Maximum RAM (GB)<input type="number" min="1" max="64" value={settings.maxRam} onChange={(e) => update('maxRam', Number(e.target.value))}/></label>
          </div>
          <label>Java executable path<input value={settings.javaPath} onChange={(e) => update('javaPath', e.target.value)} placeholder="Leave blank to use Java found on PATH"/></label>
          <label>Additional Java arguments<input value={settings.javaArgs} onChange={(e) => update('javaArgs', e.target.value)} placeholder="-XX:+UseG1GC"/></label>
          <span className="eyebrow section-label">INSTALLATION</span><h3>Game directory</h3>
          <div className="directory"><input value={settings.gameDir} onChange={(e) => update('gameDir', e.target.value)} placeholder="Select a game directory"/><button className="outline" onClick={chooseDirectory} disabled={!settingsLoaded || busy}>Browse</button></div>
          <span className="eyebrow section-label">DISPLAY</span><h3>Window size & appearance</h3>
          <div className="field-row">
            <label>Width<input type="number" min="320" max="7680" value={settings.width} onChange={(e) => update('width', Number(e.target.value))}/></label>
            <label>Height<input type="number" min="320" max="4320" value={settings.height} onChange={(e) => update('height', Number(e.target.value))}/></label>
          </div>
          <label>Theme<select value={settings.theme} onChange={(e) => update('theme', e.target.value as 'dark' | 'light')}><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <span className="eyebrow section-label" id="microsoft-sign-in">MICROSOFT SIGN-IN</span><h3>Connect your account</h3>
          <p className="field-note">Microsoft sign-in is built into this launcher. Click Sign in with Microsoft to continue in your browser; no application ID or secret is needed from you.</p>
          <div className="settings-actions">
            <button className="play compact" onClick={saveSettings} disabled={!settingsLoaded || busy}>{busy ? 'WORKING…' : 'SAVE SETTINGS'}</button>
            <button className="outline compact" onClick={() => setPage('dev')}>DEV CENTRE</button>
          </div>
          <p className="field-note">Sign-in opens Microsoft in your browser. LightingClient never sees your password; tokens are encrypted by your operating system.</p>
        </div>
        <div className="panel tip"><span className="eyebrow">ABOUT SIGN-IN</span><h3>Sign in once</h3><p>Your account is remembered securely on this computer. Sign out removes the locally stored Microsoft session.</p></div>
      </div>}

      {page === 'dev' && <div className="page-layout page-enter">
        <div className="panel">
          <span className="eyebrow">GITHUB RELEASES</span>
          <h3>Publish a launcher update</h3>
          <p className="panel-copy">LightingClient checks GitHub Releases for updates. Publish a new version tag to build and upload the installer automatically. Use GitHub’s release page to edit the announcement title and description; no publishing password is stored in this app.</p>
          <div className="settings-actions">
            <button className="play compact" onClick={openReleaseManager}>OPEN RELEASE MANAGER</button>
            <button className="outline compact" onClick={checkForUpdates}>CHECK FOR UPDATES</button>
          </div>
          {updateStatus.status === 'not-available' && <p className="field-note">This installation is up to date.</p>}
          <p className="field-note">To publish: bump the package version, push a matching <code>vX.Y.Z</code> tag, then wait for the GitHub Actions release workflow to finish.</p>
        </div>
      </div>}

      {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      <footer><span>LIGHTINGCLIENT · v{appVersion}</span><span>NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</span></footer>
    </section>
  </main>
}

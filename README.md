# LightingClient

LightingClient is an independent Minecraft Java Edition launcher built with Electron, React, TypeScript, XMCL, and Microsoft Authentication Library (MSAL). It uses Mojang's official version manifest and metadata, checks the selected release's Java requirement, verifies Minecraft Java ownership, and keeps Microsoft token cache data encrypted with Electron `safeStorage`.

## Requirements

- Windows, macOS, or Linux
- Node.js 22.12 or newer and npm 10.8 or newer
- A Java runtime compatible with the selected release, available as `java` on `PATH` or selected in Settings
- A Microsoft account with Minecraft: Java Edition

Java is checked against the selected release's official version metadata. For example, Mojang currently specifies Java 21 for Minecraft 1.21.11 and Java 25 for 26.3; future releases may change this.

## Install and run

```powershell
npm install
npm test
npm run typecheck
npm run dev
```

Release builds bundle LightingClient's public Microsoft OAuth client ID from `src/main/authConfig.ts`, so players only need to click **Sign in with Microsoft**. Local development builds use the same configuration. Sign-in opens the Microsoft browser flow and remembers the account on this computer; LightingClient never collects a Microsoft password.

## Microsoft app registration

The launcher publisher must configure a public/native desktop application registration in Microsoft Entra:

1. Select the account types that include personal Microsoft accounts.
2. Add the `http://localhost` redirect URI for the **Mobile and desktop applications** platform. MSAL uses a loopback callback and PKCE.
3. Store the registration's **Application (client) ID** in `src/main/authConfig.ts`. The ID is bundled in the launcher; users do not enter it.
4. Do not create or distribute a client secret. A desktop app is a public client.

If sign-in reports that the account does not exist in the **Microsoft Services** tenant, check that the bundled client ID belongs to an app registration that supports personal Microsoft accounts. The ID `74658136-14ec-4630-ad9b-26e160ff0fc6` belongs to the Azure Portal and cannot be used by LightingClient.

The client ID is public application configuration. Microsoft, Xbox, or Minecraft Services may require additional registration, account eligibility, or consent before this flow can be used. The launcher obtains Xbox and Minecraft tokens in the main process, checks the Minecraft Java entitlements endpoint, and only then retains an authenticated profile. It does not expose tokens through the preload API.

The public ID is embedded in the application as the OAuth client configuration; do not put a client secret in the launcher. Players sign in without entering an app ID.

Session cache data is encrypted using the operating system credential facilities through Electron `safeStorage`. Log out clears the local MSAL cache; it does not remotely revoke Microsoft grants. Users can revoke an app's permission from their Microsoft account security settings.

## Minecraft versions and launch

- The release list comes from Mojang's `version_manifest_v2.json`; release IDs below 1.21.11 and snapshots are excluded.
- Fabric can be installed from the Mods page for a supported release. Add compatible Fabric mod `.jar` files there and choose the installed Fabric profile from the Play version dropdown.
- The Plugins page can install and toggle selected Fabric client-side HUD/quality-of-life mods from Modrinth. Required dependencies are installed automatically, downloads are checked against Modrinth SHA-512 hashes, and enabling a plugin installs/selects the matching Fabric profile. Restart Minecraft after changing plugins.
- The Worlds page lists local saves with their preview image, file-system creation date, last-played time, and game mode. Click a world to launch it directly in the selected Minecraft version. Import a world by copying its folder into the configured game directory's `saves` folder, then refresh the list.
- The Skins & Capes page previews textures from the loaded Minecraft Java profile. Cape changes require sign-in; there is no public cosmetic catalog or username lookup.
- Metadata URLs and Java requirements are read from the official manifest/version metadata, not hardcoded download URLs.
- XMCL downloads the client, libraries, and assets with progress events and launches with the Minecraft access token and profile returned by Minecraft Services.
- The default game directory is `%APPDATA%\\.minecraft-lightingclient`. The selected directory is not deleted automatically.
- Existing settings and encrypted sign-in cache data are copied forward from older Blockcraft Launcher data folders when LightingClient starts.
- Java executable, additional JVM arguments, RAM, dimensions, and theme can be configured in Settings.
- The launcher uses animated electric-blue and violet lighting in both dark and light themes, with motion reduced when the operating system requests reduced motion.

Java arguments are passed as an argument array (never through a shell). Use quotes for values containing spaces. The launcher does not accept a command string from the renderer.

## Tests and builds

```powershell
npm test
npm run typecheck
npm run build
npm run dist
```

`npm run build` performs strict TypeScript checking and builds the Electron main process, preload, and renderer into `out\\`. `npm run dist` creates a Windows NSIS installer in `release\\`; with package version 1.0.1, its filename is `LightingClient-Setup-1.0.1.exe`. Build the installer on Windows for best results. Code signing is recommended for distribution.

## Security notes

- The renderer runs with context isolation, sandboxing, Node integration disabled, a restrictive content security policy, and a narrow preload API.
- IPC handlers validate the sender and settings/version inputs.
- Access and refresh tokens remain in the Electron main process and are stored only in the encrypted MSAL cache.
- Never publish user token caches, local user-data folders, or private app-registration material.
- This project is not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang Synergies AB.

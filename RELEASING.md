# Publishing LightingClient updates

The public GitHub Releases page is the update feed. The Windows release workflow builds the NSIS installer and publishes it with the `latest.yml` metadata and blockmap used by the in-app updater.

## Publish a release

From a clean checkout on `main`, run:

```powershell
npm version patch
git push origin main --follow-tags
```

`npm version patch` increments the package version and creates a matching `vX.Y.Z` tag. The tag starts the **Publish Windows release** GitHub Actions workflow. Wait for the workflow to finish, then open the release in GitHub to edit its title and description. Those release notes are shown in the launcher's update notice.

The workflow uses GitHub's short-lived `GITHUB_TOKEN`; no personal access token or publisher password is stored in the launcher. The Dev Centre opens GitHub Releases in the browser, where GitHub requires the publisher to sign in.

## Existing installations

Version 1.0.1 has no updater. Install the first updater-enabled release once using its setup installer. Later versions can be checked, downloaded, and installed from inside the launcher.

The automated release workflow currently publishes Windows installers only. macOS and Linux releases need their own builds; macOS auto-updates also require signing and notarization configuration.

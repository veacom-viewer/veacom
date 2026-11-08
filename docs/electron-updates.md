# VEAcom installers and updates

The [first departmental beta](https://github.com/veacom-viewer/veacom-private/releases/tag/v0.1.0-beta.1) is a private prerelease tagged `v0.1.0-beta.1`. New releases use the [VEAcom releases page](https://github.com/veacom-viewer/veacom/releases). Subsequent betas use `0.1.0-beta.2`, `0.1.0-beta.3`, and so on.

The repository is private. This beta does not poll an update service, download an installer, or carry a GitHub token. **Updates → Release page** opens this repository in the user's browser only when selected. Staff need repository access to use that page. The department administrator can also distribute the verified assets internally.

## Packaging

The release configuration keeps the app identity `com.veacom.electron` and display name **VEAcom Electron**. Windows uses an interactive per-user installer. The standard distribution build requires signing and macOS notarization. The owner approved an exception for the first private department beta: a Windows x64 NSIS installer and an Apple Silicon Mac disk image without a publisher signature or notarization. The release notes declare this and include SHA-256 checksums. Leave the standard signing configuration enabled for other releases.

| Target | Expected asset for this beta |
| --- | --- |
| Windows x64 | `VEAcom-Electron-0.1.0-beta.1-win-x64-Installer.exe` |
| macOS Apple Silicon | `VEAcom-Electron-0.1.0-beta.1-mac-arm64.dmg` |

Use `pnpm install --frozen-lockfile`, `pnpm run setup:runtime`, `pnpm run build:core`, and `pnpm run build:web`. On Windows, run `scripts/windows-runtime.ps1` for the packaged native runtime. electron-builder installs apart from the root: run `pnpm --dir packaging install --frozen-lockfile`, then, from the repository root, `node packaging/node_modules/electron-builder/cli.js --config electron-builder.release.cjs --win nsis --x64 --publish never` or `node packaging/node_modules/electron-builder/cli.js --config electron-builder.release.cjs --mac dmg --arm64 --publish never`, only with the approved signing setup. Verify the packaged viewer and signatures before attaching installers. Signing or publishing a release requires owner approval.

## If public in-app updates are enabled later

`veacomPublicUpdates` in the packaged `package.json` defaults to `false`. Enable it only when this repository's release assets are available without credentials. The updater accepts only published `v<semver>` tags in this repository. The GitHub prerelease flag must agree with the version, and stable builds do not offer beta updates.

The asset must match the viewer's OS, architecture and exact filename. The expected size, SHA-256 digest and download URL come from that release. Downloads require user action. Before launching an installer, VEAcom rechecks the bytes and the OS signature against the installed Windows publisher or Apple team, preserves internet-origin markers, and asks for confirmation. Source builds cannot install updates. No renderer input can choose a different feed or installer.

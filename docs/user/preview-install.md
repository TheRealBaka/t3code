# Install T3 Code Preview on a Mac

T3 Code Preview is an independent, experimental fork of T3 Code. The initial download supports Apple Silicon Macs (M1, M2, M3, and later). An M2 Mac uses the **arm64** download, not an Intel/x64 build.

## Install

1. Visit [GitHub Releases](https://github.com/TheRealBaka/t3code/releases) and open the newest **T3 Code Preview** prerelease.
2. Expand **Assets** and download `T3-Code-Preview-…-arm64.dmg`. The automatically generated **Source code** downloads are not installers.
3. Open the DMG and drag **T3 Code Preview** into **Applications**.
4. Eject the installer and open **T3 Code Preview** from Applications.

No official T3 installation is required. The app bundles its server; you do not need to compile anything.

## macOS blocks opening the app

These preview builds are unsigned and are not Apple-notarized. Only approve a download you obtained from this repository's Releases page and trust.

After attempting to open the app, go to **System Settings → Privacy & Security**. If macOS shows a blocked-app notice, choose **Open Anyway**, authenticate, and confirm opening it.

Some macOS versions instead report that the unsigned app is “damaged.” First download it again and optionally verify its checksum below. If the download is intact and you trust it, remove quarantine from **this app only** in Terminal:

```sh
xattr -dr com.apple.quarantine "/Applications/T3 Code Preview.app"
```

Then open the app again. Do not disable Gatekeeper globally, and do not run the command on your entire Applications or Downloads directory. A managed work Mac may prohibit unsigned apps regardless of these steps.

### Optional: verify the download

Download `SHA256SUMS.txt` from the same release into the same folder as the DMG. In Terminal, change to that folder and run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The DMG should report **OK**. This checks the file against the release checksum; it is not Apple signing or notarization.

## Set up a coding provider

The desktop app does not include a paid AI subscription or your friends' account credentials. Install and sign into a provider on this Mac first:

- **Claude Code:** follow the [official installation instructions](https://code.claude.com/docs/en/setup), then run `claude` in Terminal and sign in.
- **Pi Agent:** follow the [Pi setup guide](providers-pi-agent.md) to install Pi and authenticate its model provider.
- **Other providers:** install and authenticate the corresponding CLI before enabling it in the app.

Open **Settings → Providers**, add or enable the provider, and then open a project folder and start a thread.

If a provider cannot be found, verify it starts in Terminal. Use `command -v claude` or `command -v pi` to find its executable, and enter that path in its provider settings. The path belongs to your Mac; do not copy someone else's home-directory path.

## Data and updates

- Preview server data lives under `~/.t3-preview/userdata` by default.
- Electron's preview profile lives under `~/Library/Application Support/t3code-preview` or `~/Library/Application Support/T3 Code Preview`.
- Official T3 conversations and settings are not automatically imported. Existing provider sign-ins may still be reused, because provider credentials belong to the provider rather than the T3 app.
- If you have explicitly set `T3CODE_HOME`, it overrides the preview server-data location. Do not point this older fork at a newer official T3 database.
- To update, fully quit Preview, download a newer DMG, and replace **T3 Code Preview.app**. Updates are manual and retain your preview data. You may need to approve each unsigned download.
- To uninstall, quit the app and remove **T3 Code Preview.app**. Your preview data remains available if you reinstall. Do not remove official T3 or provider data as part of uninstalling Preview.

## Remote connections

The first packaged release is intended for **local use on your Mac**. T3 Connect cloud login and its hosted relay are not configured in these downloads.

Direct connections can be configured with your own server, but it should run this same fork/version to support its extra features. Stock T3 servers do not necessarily understand preview features. The official mobile client is not a supported preview client.

Automatic SSH installation of the fork is not included yet. The inherited SSH launcher may look for the official `t3` package, so do not assume adding an SSH environment installs this fork on the remote machine. Use local projects for the initial preview; a separately packaged remote-server installation will be documented when available.

## Known limitations

- **No Mac interactive verification yet:** a successful automated build is not a full installation or real-provider test. Report installation problems with your macOS version and the preview release number.
- Side chats are currently **Claude-only** and ephemeral. They can disappear after closing, server restarts, or idle expiry; do not use them as durable notes.
- Pi supports **Full Access** only. Use another provider for generated commit messages and thread titles.
- Claude subscription usage currently reads file-based credentials, not macOS Keychain. Its usage dialog can report unavailable even when Claude conversations work. Do not export your credentials to work around this.
- Some workspace video formats depend on the codecs supported by Electron.
- This is based on upstream **0.0.38**, not current upstream T3. It does not contain all later fixes or features.

When reporting an issue, include the preview version, macOS version, provider, and what failed. Remove tokens, personal paths, and private conversation text from logs or screenshots before sharing them.

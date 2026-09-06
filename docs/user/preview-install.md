# Install T3 Code++

T3 Code++ is an independent, experimental fork of T3 Code. Downloads exist for Apple Silicon Macs, 64-bit Windows, and 64-bit Linux. Every build is unsigned, so each operating system asks for an approval the first time. Only approve a download you obtained from this repository's Releases page and trust.

## Download

1. Visit [GitHub Releases](https://github.com/TheRealBaka/t3code/releases) and open the newest **T3 Code++** prerelease.
2. Expand **Assets** and download the file for your machine. The automatically generated **Source code** downloads are not installers.

| Machine | File |
| --- | --- |
| Apple Silicon Mac (M1, M2, M3, and later) | `T3-Code-PlusPlus-…-arm64.dmg` |
| Windows 10/11, 64-bit | `T3-Code-PlusPlus-…-x64.exe` |
| Linux, 64-bit | `T3-Code-PlusPlus-…-x64.AppImage` |

No official T3 installation is required. The app bundles its server; you do not need to compile anything. An Intel Mac needs an x64 build, which is not published.

### Optional: verify the download

Download `SHA256SUMS.txt` from the same release into the same folder as the installer. Then, in a terminal in that folder:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS.txt
```

On Windows PowerShell, compare the value from `Get-FileHash .\T3-Code-PlusPlus-*-x64.exe` with the line for that file in `SHA256SUMS.txt`. A match checks the file against the release checksum; it is not code signing.

## macOS

1. Open the DMG and drag **T3 Code++** into **Applications**.
2. Eject the installer and open **T3 Code++** from Applications.

After attempting to open the app, go to **System Settings → Privacy & Security**. If macOS shows a blocked-app notice, choose **Open Anyway**, authenticate, and confirm opening it.

Some macOS versions instead report that the unsigned app is “damaged.” First download it again and optionally verify its checksum. If the download is intact and you trust it, remove quarantine from **this app only** in Terminal:

```sh
xattr -dr com.apple.quarantine "/Applications/T3 Code++.app"
```

Then open the app again. Do not disable Gatekeeper globally, and do not run the command on your entire Applications or Downloads directory. A managed work Mac may prohibit unsigned apps regardless of these steps.

## Windows

1. Run the downloaded `.exe`. SmartScreen shows **Windows protected your PC** because the installer is unsigned.
2. Click **More info**, then **Run anyway**.
3. Follow the installer. It installs for the current user and creates a Start Menu entry named **T3 Code++**.

If your browser flagged the download, keep the file from the download prompt before running it. Antivirus tools may also quarantine unsigned installers; restore the file only if you trust this repository. A managed work PC may block unsigned installers entirely.

To use providers inside WSL, the Windows build ships the Linux terminal backend it needs; nothing has to be compiled on first launch.

## Linux

1. Make the AppImage executable and start it:

   ```sh
   chmod +x T3-Code-PlusPlus-*-x64.AppImage
   ./T3-Code-PlusPlus-*-x64.AppImage
   ```

2. If it exits immediately with a FUSE error, install `libfuse2` from your distribution, or run it with `--appimage-extract-and-run`.

The AppImage does not add itself to your application menu. Tools such as AppImageLauncher or Gear Lever can integrate it if you want a launcher entry. Wayland and X11 are both supported by Electron; if the window fails to appear on Wayland, try launching with `--ozone-platform=x11`.

## Set up a coding provider

The desktop app does not include a paid AI subscription or your friends' account credentials. Install and sign into a provider on this machine first:

- **Claude Code:** follow the [official installation instructions](https://code.claude.com/docs/en/setup), then run `claude` in a terminal and sign in.
- **Pi Agent:** follow the [Pi setup guide](providers-pi-agent.md) to install Pi and authenticate its model provider.
- **Other providers:** install and authenticate the corresponding CLI before enabling it in the app.

Open **Settings → Providers**, add or enable the provider, and then open a project folder and start a thread.

If a provider cannot be found, verify it starts in a terminal. Use `command -v claude` or `command -v pi` (`where claude` on Windows) to find its executable, and enter that path in its provider settings. The path belongs to your machine; do not copy someone else's home-directory path.

## Data and updates

- Server data lives under `~/.t3-preview/userdata` by default, which is `%USERPROFILE%\.t3-preview\userdata` on Windows.
- Electron's profile lives under `~/Library/Application Support/t3code-preview` on macOS, `%APPDATA%\t3code-preview` on Windows, and `~/.config/t3code-preview` on Linux.
- Official T3 conversations and settings are not automatically imported. Existing provider sign-ins may still be reused, because provider credentials belong to the provider rather than the T3 app.
- If you have explicitly set `T3CODE_HOME`, it overrides the server-data location. Do not point this older fork at a newer official T3 database.
- To update, fully quit the app, download a newer installer, and install it over the old one (or replace the AppImage). Updates are manual and retain your data. You may need to approve each unsigned download.
- To uninstall, quit the app and remove it: delete the app on macOS, use **Apps → Installed apps** on Windows, or delete the AppImage on Linux. Your data remains available if you reinstall. Do not remove official T3 or provider data as part of uninstalling.

## Remote connections

The packaged releases are intended for **local use on your machine**. T3 Connect cloud login and its hosted relay are not configured in these downloads.

Direct connections can be configured with your own server, but it should run this same fork/version to support its extra features. Stock T3 servers do not necessarily understand this fork's features. The official mobile client is not a supported client.

Automatic SSH installation of the fork is not included yet. The inherited SSH launcher may look for the official `t3` package, so do not assume adding an SSH environment installs this fork on the remote machine. Use local projects for now; a separately packaged remote-server installation will be documented when available.

## Known limitations

- **Limited interactive verification:** a successful automated build is not a full installation or real-provider test on every platform. Report installation problems with your operating system version and the release number.
- Side chats are currently **Claude-only** and ephemeral. They can disappear after closing, server restarts, or idle expiry; do not use them as durable notes.
- Pi supports **Full Access** only. Use another provider for generated commit messages and thread titles.
- Claude subscription usage currently reads file-based credentials, not macOS Keychain. Its usage dialog can report unavailable even when Claude conversations work. Do not export your credentials to work around this.
- Some workspace video formats depend on the codecs supported by Electron.
- This is based on upstream **0.0.38**, not current upstream T3. It does not contain all later fixes or features.

When reporting an issue, include the release version, operating system version, provider, and what failed. Remove tokens, personal paths, and private conversation text from logs or screenshots before sharing them.

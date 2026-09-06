## T3 Code Preview — Apple Silicon

Independent preview fork based on T3 Code 0.0.38, with Pi integration, math and video rendering, reply comments, and Claude side chats.

### Install

1. Download the **arm64.dmg** asset below (M1/M2/M3 and later Macs).
2. Open it and drag **T3 Code Preview** into **Applications**.
3. Open the app and configure your installed coding provider in **Settings → Providers**.

**Unsigned and not notarized:** macOS may block opening the app. See the [installation guide](https://github.com/TheRealBaka/t3code/blob/release/preview/docs/user/preview-install.md) for approval steps, checksum verification, and troubleshooting.

The app installs alongside official T3, stores data separately, and uses manual updates. Provider subscriptions are not included. This initial release targets local use; T3 Connect cloud login/relay and automatic installation of the fork over SSH are not included.

### Limitations

- Experimental prerelease; automated packaging checks are not a real-Mac conversation test.
- Claude side chats only; Pi uses Full Access.
- Claude's usage dialog does not yet read macOS Keychain credentials.
- Based on upstream 0.0.38; not the latest official T3 release.
- No Intel Mac, Windows, Linux, or mobile downloads in this initial release.

Download **SHA256SUMS.txt** if you want to verify the DMG. The **Source code** assets are not installers.

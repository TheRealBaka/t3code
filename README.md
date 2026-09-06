# T3 Code Preview

An independent fork of [T3 Code](https://github.com/pingdotgg/t3code), based on v0.0.38, with Pi provider support and extended chat features. Not an official T3 release.

## Download and install

**[Download from GitHub Releases](https://github.com/TheRealBaka/t3code/releases)**

Choose the newest **T3 Code Preview** prerelease and download the `arm64.dmg` file under **Assets**. The initial target is **Apple Silicon Macs**, including M1, M2, M3, and later chips. Intel Macs, Windows, Linux, and mobile are not part of this initial packaged release.

Open the DMG, drag **T3 Code Preview** into **Applications**, then open it from Applications. You do not need the official T3 app, Git, Node.js, or a compiler just to install the desktop app. Your coding provider may have its own prerequisites.

**The app is unsigned and not notarized.** macOS may require an explicit approval before it opens. Follow the [installation and troubleshooting guide](docs/user/preview-install.md).

Install and sign into at least one coding provider on your Mac, then enable it in **Settings → Providers**. Provider subscriptions and API access are not included.

> `npx t3@latest`, the official T3 website, and the Homebrew `t3-code` cask install upstream T3, **not this fork**. Do not patch an official app with files from this repository.

## What's included

- Pi Agent provider integration, with thinking levels, tool output, and usage reporting.
- Math rendering and inline workspace videos in web/desktop chat.
- Comments on highlighted assistant text, attached to the composer.
- Claude side chats with model/effort controls, attachments, and selection context.
- Claude skill discovery and a subscription usage dialog.

Side chats currently require Claude. Pi currently supports Full Access only. The Claude subscription usage dialog does not yet read macOS Keychain credentials; normal Claude conversations do not depend on that dialog.

## Separate from official T3

The app installs as **T3 Code Preview** and uses its own local data directory, `~/.t3-preview`. It does not automatically import official T3 conversations or settings. Avoid setting `T3CODE_HOME` to an official installation's data directory.

Updates are manual: download a newer preview DMG and replace the application while it is closed. Your preview data stays in place. Official T3 auto-updates cannot replace this build.

T3 Connect cloud login/relay is not configured in preview downloads. This does not affect local coding-provider login. For remote work, see the [connection limitations](docs/user/preview-install.md#remote-connections).

## Development and releases

The `release/preview` branch is the release source. GitHub Actions builds the Apple Silicon DMG and publishes a prerelease after focused checks pass. See the [release runbook](docs/operations/preview-releases.md).

## Credits and license

T3 Code is built by the upstream maintainers and contributors. The Pi provider integration derives from [PR #9648](https://github.com/pingdotgg/t3code/pull/9648) by NachikethReddyY; math rendering incorporates work from [PR #9838](https://github.com/pingdotgg/t3code/pull/9838).

This fork retains the upstream [MIT license](LICENSE). For the official project, documentation, and contribution policies, visit [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

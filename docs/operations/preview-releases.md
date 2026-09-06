# T3 Code++ desktop releases

The fork's release source is `release/preview`; upstream `main` is not the release source. The current release line remains based on v0.0.38. Do not splice its server bundle into a newer official desktop shell.

## Publishing

Push a reviewed commit to `release/preview` on `TheRealBaka/t3code`. The **Preview desktop release** workflow:

1. `checks` (Ubuntu): installs the locked desktop/server dependency graph, runs the focused feature/packaging tests and the desktop, web, and server typechecks, and resolves the version `0.0.38-preview.<workflow-run-number>`.
2. `wsl_node_pty` (Ubuntu): builds the Linux `pty.node` that the Windows package bundles for its WSL backend.
3. `build` (matrix): packages unsigned installers on standard GitHub-hosted runners, stamps the version into release package manifests, inspects each bundle, and writes a per-platform SHA-256 file.
   - macOS arm64 DMG on `macos-15`: bundle identity, architecture, no updater feed, server `--help` smoke.
   - Linux x64 AppImage on `ubuntu-24.04`: extracts the image, checks the executable and the absence of an updater feed, server `--help` smoke.
   - Windows x64 NSIS installer on `windows-2025`: installer present. Windows needs the Spectre-mitigated MSVC libraries for native rebuilds and the WSL prebuild from step 2.
4. `publish` (Ubuntu): merges the checksum files into one `SHA256SUMS.txt` and publishes a GitHub prerelease tagged `preview-<version>` from that exact commit using the workflow's built-in `GITHUB_TOKEN`.

No Apple certificate, Apple Developer membership, Windows code-signing certificate, personal access token, cloud credentials, or self-hosted runner is required. GitHub Actions must be enabled on the fork. Standard hosted runner use is free for public repositories under GitHub's public-repository Actions policy; do not substitute paid/larger runners without reviewing billing. Windows builds are the slowest leg; expect the whole run to take roughly 30 to 45 minutes.

The publish job alone has `contents: write`. A failure in checks or in any platform build prevents publication, so a release always carries all three installers. Workflow artifacts are retained for 14 days; release downloads remain available until the release is removed. Rerunning a workflow replaces assets on its existing prerelease, while a new workflow run receives a new version.

The workflow is also manually dispatchable; branch pushes work even when the workflow is not on the default branch. Existing upstream release/deployment workflows are not used to publish this fork. Do not create official-style `v*` tags to trigger them.

## Build identity and configuration

- Product: `T3 Code++` (artifact files use `T3-Code-PlusPlus-<version>-<arch>.<ext>`, since `+` is awkward in URLs and shells)
- Bundle ID: `io.github.therealbaka.t3code.preview`
- Desktop schemes: `t3code-preview`, `t3code-preview-dev`
- Default server home: `~/.t3-preview`
- Electron profiles: `t3code-preview` / `T3 Code Preview` (legacy name kept for the profile-migration path), with separate development variants
- Linux executable, WM class, and desktop entry: `t3code-preview`
- Versions carrying `-preview.` omit update feeds, including when `GITHUB_REPOSITORY` is set.
- The workflow does not copy `.env.example`: official Clerk login, relay, and passkey signing configuration are not embedded.

The internal identifiers deliberately kept the `preview` name when the product was renamed to T3 Code++, so existing installs keep their data directories and URL scheme registrations. Renaming them is a migration, not a label change.

Explicit `T3CODE_HOME` remains an advanced override. Never test against a live official installation's userdata. Provider sign-ins are still provider-owned; app isolation does not clone or delete them.

## Verification and support

Building an installer does not prove interactive behavior. Have a tester install the exact release on each platform, approve the unsigned download, configure a provider, send a turn, exercise the intended chat features, and confirm the official app still opens with its own data. Browser/computer-use verification requires the maintainer's permission.

The release notes deliberately document macOS Keychain usage-limit support and fork-aware SSH provisioning as limitations. Do not advertise them as verified. Intel macOS, Windows on ARM, and upstream migration are separate follow-up work.

For a bad release, remove its download or mark it clearly as broken, fix the source, and publish a new release. Do not recommend downgrading against data already migrated by a newer release without a backup.

## Local-only material

Personal patch scripts, the old `README-PI.md`, local build output, and recordings are ignored and are not release inputs. Do not use `git add -f` to include them. The release branch consolidates the original local feature commits under the maintainer's chosen public email; the original working branch remains local as a recovery point.

# Preview desktop releases

The fork's release source is `release/preview`; upstream `main` is not the release source. The current preview remains based on v0.0.38. Do not splice its server bundle into a newer official desktop shell.

## Publishing

Push a reviewed commit to `release/preview` on `TheRealBaka/t3code`. The **Preview desktop release** workflow:

1. Runs on the standard GitHub-hosted `macos-15` runner.
2. Installs the locked desktop/server dependency graph and Rust toolchain.
3. Runs focused feature/packaging tests and desktop, web, and server typechecks.
4. Stamps `0.0.38-preview.<workflow-run-number>` into release package manifests.
5. Builds an unsigned `arm64` DMG, checks bundle identity/architecture and absence of an updater feed, and generates a SHA-256 checksum.
6. Publishes a GitHub prerelease tagged `preview-<version>` from that exact commit using the workflow's built-in `GITHUB_TOKEN`.

No Apple certificate, Apple Developer membership, personal access token, cloud credentials, or self-hosted runner is required. GitHub Actions must be enabled on the fork. Standard hosted runner use is free for public repositories under GitHub's public-repository Actions policy; do not substitute paid/larger runners without reviewing billing.

The publish job alone has `contents: write`. A build/check failure prevents publication. Workflow artifacts are retained for 14 days; release downloads remain available until the release is removed. Rerunning a workflow replaces assets on its existing prerelease, while a new workflow run receives a new version.

The workflow is also manually dispatchable once GitHub recognizes it; branch pushes work even when the workflow is not on the default branch. Existing upstream release/deployment workflows are not used to publish this fork. Do not create official-style `v*` tags to trigger them.

## Build identity and configuration

- Product: `T3 Code Preview`
- Bundle ID: `io.github.therealbaka.t3code.preview`
- Desktop schemes: `t3code-preview`, `t3code-preview-dev`
- Default server home: `~/.t3-preview`
- Electron profiles: `t3code-preview` / `T3 Code Preview`, with separate development variants
- Preview versions omit update feeds, including when `GITHUB_REPOSITORY` is set.
- The workflow does not copy `.env.example`: official Clerk login, relay, and passkey signing configuration are not embedded.

Explicit `T3CODE_HOME` remains an advanced override. Never test against a live official installation's userdata. Provider sign-ins are still provider-owned; preview app isolation does not clone or delete them.

## Verification and support

Building a DMG does not prove interactive Mac behavior. Have a tester install the exact release on an Apple Silicon Mac, approve the unsigned download, configure a provider, send a turn, exercise the intended chat features, and confirm the official app still opens with its own data. Browser/computer-use verification requires the maintainer's permission.

The initial release deliberately documents macOS Keychain usage-limit support and fork-aware SSH provisioning as limitations. Do not advertise them as verified. Linux/Windows packaging and upstream migration are separate follow-up work.

For a bad release, remove its download or mark it clearly as broken, fix the source, and publish a new preview. Do not recommend downgrading against data already migrated by a newer release without a backup.

## Local-only material

Personal patch scripts, the old `README-PI.md`, local build output, and recordings are ignored and are not release inputs. Do not use `git add -f` to include them. The release branch consolidates the original local feature commits under the maintainer's chosen public email; the original working branch remains local as a recovery point.

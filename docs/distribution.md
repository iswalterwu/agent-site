# Install Agent Site

[简体中文](distribution.zh-CN.md) · [Project overview](../README.md)

> **Read me:** Install, configure, remove or roll back the Windows desktop component and the optional DSH plugin. Distribution behavior is specified by DIST; the pi bridge is documented in the project README.

## Choose your files

Use files from the same version on the project's GitHub Releases page:

| File | Purpose |
| --- | --- |
| `agent-site-<version>-win-x64.zip` | Windows 11 x64 desktop component, including its Electron runtime |
| `dsh-agent-site-<version>.tgz` | Optional prebuilt DSH launch plugin; not the desktop runtime |
| `SHA256SUMS` | SHA-256 checksums for those two files |

The portable app needs no separately installed Node.js, npm or Electron. Git 2.31+ is used for Git/worktree project recognition. The plugin is tested with DSH `0.2.1-rc.3` and `0.2.2-rc.1`; other versions are not declared compatible. macOS, Linux, ARM64 and remote desktop launching are outside this release's support.

## Check the download

Download only from this project's release page. In PowerShell:

```powershell
Get-FileHash .\agent-site-<version>-win-x64.zip -Algorithm SHA256
Get-FileHash .\dsh-agent-site-<version>.tgz -Algorithm SHA256
```

Compare both results with `SHA256SUMS`. A checksum detects a damaged or mismatched download; it is not a publisher signature. This portable build is **unsigned**, so Windows may show an unknown-publisher or SmartScreen warning. Review the source and download origin; do not turn off system protection just to run it.

## Open the desktop window

1. Extract the **whole ZIP** to a writable local folder.
2. Keep `AgentSite.exe`, `agent-site.json`, `resources/` and the runtime files together.
3. Run `AgentSite.exe`. With no sessions it shows an empty site.

The first language follows the system. In Settings, choose English or Chinese and save to switch immediately. The app is not an agent launcher: keep using your normal terminal. Claude Code and DSH are read-only; pi controls need the separately installed bridge.

## Add the DSH entry

- **Official DSH Desktop:** use the app's own **Plugins → Add plugin** page to install the local `.tgz`, then enable it. Do not assume a CLI `web` profile is the Desktop app's profile.
- **Local `dsh web`:** install into the profile you actually run:

```text
dsh plugin --profile <profile> add <absolute-path-to-plugin.tgz>
```

Open Agent Site's plugin page, enter the path to the fully extracted `AgentSite.exe`, and **Save**. Then choose **Open Agent Site**. Installing the plugin does not download or start the desktop component.

The window opens on the **Windows computer running DSH**, not on a remote browser's computer. The entry uses the host's saved configuration and resolved `DSH_HOME`; it does not send session contents through the plugin or call a model.

## Data roots and troubleshooting

- DSH sessions: `--dsh-home` overrides `DSH_HOME`, which overrides `~/.dsh`. A legal missing root stays empty and is not created. pi and Claude keep their normal session roots.
- Custom-root CLI example: `AgentSite.exe --dsh-home "<absolute-DSH-directory>"`.
- If an existing window uses a different root, quit it and open from the intended DSH host. The app does not silently replace the active root.
- Missing/incompatible component: select `AgentSite.exe` from the **complete extracted folder**, with its matching `agent-site.json`; do not select `electron.exe` or move only the executable.
- Save failed: your draft is retained. Resolve the host's configuration/write problem before saving again; Open never uses an unsaved path.
- Timed out/disconnected: the result is unknown. No retry is sent automatically; inspect the desktop before choosing Open again.

App settings and local control records are in `%APPDATA%\agent-site`, or `AGENT_SITE_HOME` when set. The app does not migrate, delete or rewrite Harness sessions. Startup registration follows the app's opt-in setting, not plugin installation.

## Remove or roll back

1. Disable or uninstall the bundle with DSH's plugin manager; for a local web profile, `dsh plugin --profile <profile> remove dsh-agent-site` is equivalent.
2. An opened Agent Site window remains independent. Quit it separately when desired.
3. Before removing the portable folder, turn **Start at login** off in Agent Site and save.
4. To roll back, extract a compatible release into a separate folder and select its executable in the plugin. Keep each release's files together.

Removing the plugin or portable folder does not remove App data or Harness sessions. The DSH plugin neither installs nor uninstalls the pi bridge. For pi bridge setup and removal, follow the project README.

## Build and distribute

For maintainers, `npm run build:distribution` makes **local development artifacts**, not an approved public release. `npm run check:distribution` inspects archive allowlists, identities, licenses, media, checksum basenames and common private paths/credential patterns. It does not replace an independent source, privacy and image review.

After separately authorized public-code synchronization, use a clean checkout of that reviewed public `origin/main` commit:

```text
npm ci
npm run prepare:release
```

Preparation rebuilds and checks the artifacts, then collects only the current ZIP, TGZ and `SHA256SUMS` into `dist/release/<version>/`. It refuses a private repository, dirty source or a commit not synchronized to public `origin/main`; it does not fetch, push, tag, upload or submit anything. A failure leaves no approved new release set: fix the reported source/build/check issue and prepare again.

Release upload and a store PR each need their own execution approval. Upload only the collected files under tag `v<version>`. The catalog source is `packages/dsh-plugin/marketplace.yml`; submit it as `data/plugins/iswalterwu__agent-site--packages-dsh-plugin.yml` to `awesome-dsh-plugin/awesome-dsh-plugin`, without changing generated READMEs or other entries. Its version-pinned tarball points to the matching Release. Recheck the catalog's current rules, repository age, `dsh-plugin` topic and downloadable files before submitting. The separate 1024 Store's npm installation path is not part of this release.

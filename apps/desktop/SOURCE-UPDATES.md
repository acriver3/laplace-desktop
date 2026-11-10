# Updates for locally built Desktop installations

This distribution mode builds trusted Laplace source on the user's machine. It supports macOS arm64/x64 and Windows x64. It does not require signing credentials, publish unsigned binaries as a general installer, bypass OS protections, or update development checkouts. Signing/notarization for public installers remains separate work.

## One-time setup

Install Git, Node 24, and the JavaScript distribution of pnpm 10.28.2 (`npm install -g pnpm@10.28.2`). Clone the public source repository at `https://github.com/acriver3/laplace-desktop.git`.

From a clean checkout containing the updater, run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @repo/desktop source:install
```

Setup checks the tools and available disk space, builds and probes the packaged app, and opens it. The default locations are `~/Applications/Laplace.app` on Mac and `%LOCALAPPDATA%\LaplaceSource\app` on Windows. No administrator permission is requested. Git and the recorded Node/pnpm installations must remain available for subsequent updates; rerun setup if their paths change.

If Laplace already exists on Mac, quit it and explicitly adopt its location:

```sh
pnpm --filter @repo/desktop source:install --adopt /Applications/Laplace.app
```

Only the default location and `/Applications/Laplace.app` can be adopted. The target must be writable by the current user. Existing Windows Squirrel installations are a separate distribution mode: use the source-built app's stable location and register assistants with that installation. Do not overwrite a Squirrel-managed version directory.

The updater stores ownership, tool paths, source identity, staging files, and its recovery journal in `~/.laplace-desktop-updates`. Application profiles and keychain entries retain their existing locations. Update installation keeps the executable and bridge paths stable. Git credentials remain in the user's Git credential system; they are never copied into installation metadata or sent to the renderer.

## Using updates

The app checks the latest public GitHub Release 15 seconds after launch, every six hours while running, and when **Check for updates** is selected in **On this device → Updates**. It verifies the release manifest against the Ed25519 public key pinned in its source. Metadata checks never fetch source trees or install packages.

**Download update** fetches the exact selected release into an isolated checkout, checks its commit and version, installs the frozen dependency lockfile, and builds a native package. Downloading a release authorizes running its trusted build scripts. There is no Git pull, stash, reset, or edit in the user's original checkout. The current app remains usable while building. The UI reports download, build, and verification phases; it does not invent a percentage for subprocesses that provide none.

**Cancel** stops update-owned build processes. Failures retain the current application. Raw build output is withheld because Git, registry, or build errors can include credentials. Network/authentication, tool, disk, and build failures provide bounded recovery messages.

**Restart to install** stops managed tools and replaces the app using a detached installer. The installer verifies the staged package digest, retains the previous app beside the installed app, and requires a startup receipt from the new main process and helper. An unsuccessful startup restores the previous application. It never installs on ordinary quit. On Windows, close AI clients using Laplace's bundled Node runtime before installation; file locks can otherwise require a retry.

After a power interruption, quit Laplace and run:

```sh
pnpm --filter @repo/desktop source:install --recover
```

Recovery finishes an accepted update or restores an interrupted replacement from the journal. It does not select arbitrary app paths or erase user data. Keep the source clone until recovery is no longer needed. This updater does not introduce data migrations; future incompatible data changes require their own recovery design.

## Publishing a source release

When the user explicitly accepts publication in place of native runner evidence, record that acceptance separately. Keep `commit`, `version`, and `localValidation: "passed"`; replace `platforms` with `userAcceptance` containing the user's verbatim `statement`, an ISO UTC `acceptedAt` timestamp, and `nativeResults: "not-attested"`. Never infer this exception from general publication permission. The annotated tag records user acceptance instead of claiming native tests passed. Exact remote-main identity and immutable version checks still apply.

Normal main pushes do not advertise Desktop updates. Increase `apps/desktop/package.json`'s version, validate the integrated source, then run the release command from a clean checkout of the exact current remote main commit:

```sh
pnpm --filter @repo/desktop source:release /absolute/path/to/native-evidence.json
```

The command creates and pushes an annotated `desktop-vX.Y.Z` tag, verifies its remote commit, and refuses to replace an existing version. This is an explicit release action. It does not deploy the web application or require GitHub Workflows. Release credentials stay with the operator's Git configuration.

Set `releaseSigningPublicKey` in `apps/desktop/package.json` to the approved Ed25519 public key in SPKI PEM format. Keep the matching private key in the release signing environment. After native validation, prepare the update manifest with:

```sh
node apps/desktop/scripts/sign-release-manifest.mjs <validated-assets-directory> <private-key-file> <source-commit>
```

Attach `update-manifest.json`, `update-manifest.sig`, and the exact validated assets to the draft public release before publishing it. The asset directory must contain the three platform ZIPs and the full Windows Squirrel package. The manifest signer records their bytes and hashes. This release channel signs the manifest separately from platform code signing.

Evidence must contain the exact `commit`, `version`, `localValidation: "passed"`, and a `platforms` object with `darwin-arm64`, `darwin-x64`, and `win32-x64` entries. Each entry requires `packaged`, `update`, and `recovery` to be `"passed"`, and `execution` to be `"native"`. Record actual runner results; do not mark unavailable platforms as passed. Rosetta is not a physical Intel acceptance result. Save detailed check logs alongside the evidence.

Run `pnpm --filter @repo/desktop test:update-filesystem` to verify physical ASAR copying, digest parity, tamper detection, and cleanup in both Node and Electron. The updater uses Electron’s `original-fs` for physical package access and the standard filesystem in standalone Node.

Run `pnpm --filter @repo/desktop check:source`, existing Desktop packaged/native checks, and `pnpm --filter @repo/desktop test:source-update` on each target. The source update smoke test uses temporary source tags, an isolated Git home, and isolated app profiles; it never publishes a tag or replaces the user's app. Unit tests cover failed startup recovery, interrupted replacements, source selection, cancellation, and IPC restrictions. Native acceptance must also verify existing keychain credentials, assistant registration paths, and Windows file-lock recovery.

The release protocol currently requires Node 24, pnpm 10.28.2, and `sourceUpdateProtocol: 1`. A future toolchain/protocol change must preserve compatibility or instruct users to rerun bootstrap. Existing builds without the updater need the one-time setup above.

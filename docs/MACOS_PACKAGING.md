# macOS packaging integrity and Actions storage

The user reports alpha.2 works and alpha.5 displays a damaged/corrupted warning. The packaging configuration and declared dependency versions did not change between those tags. This is a reported regression, not proof that every alpha.5 download is corrupt.

The alpha.5 macOS release logs show fuse changes followed by skipped application signing because certificate discovery was disabled. Previous checks inspected fuse values only; source Electron tests did not launch the final packaged application. A downloaded DMG whose SHA-256 matches the release manifest can still contain an invalidly signed app. Conversely, intact ad-hoc packages may be blocked by Gatekeeper because they lack Developer ID trust/notarization. These are different failure modes.

## Fix and checks

Development packages explicitly use identity `-` (ad-hoc), with the same Electron JIT/library-validation runtime entitlements used by the installed packager's default template. This requires no certificate, paid account, signing secret or keychain identity. Hardened runtime, sandboxing, IPC restrictions and ASAR integrity fuses remain enabled. `CSC_FOR_PULL_REQUEST=true` is scoped to the packaging step solely to allow this certificate-free signing path on PR runs; the job has read-only permissions and receives no signing credentials. Do not add production signing secrets to this job. A future Developer ID pipeline must be designed separately and change the ad-hoc defaults deliberately.

`npm run security:mac-package` must run on macOS after `npm exec electron-builder -- --publish never`. It requires both architecture DMGs, verifies each disk image, mounts read-only, checks nested signatures with `codesign --verify --deep --strict`, compares bundle versions and ASAR hashes to the unpacked build, and copies/launches the host architecture app with disposable user data. The other architecture requires a matching test device; the check never silently claims both architectures were launched. Mounted images are detached even after failure, and temporary directories are not removed while still mounted.

The startup smoke check confirms the main process stays running for eight seconds. It does not prove window rendering, OS key-store behavior or Gatekeeper acceptance after a browser download. No quarantine attributes or OS security policies are removed. Actual Intel and Apple Silicon devices must be tested, including installation, terminal rendering and native key-store behavior.

To inspect existing release assets, manually run CI with `inspect_releases=true`, `baseline=v0.2.0-alpha.2` and `suspect=v0.2.0-alpha.5`. The inspection job downloads only its host-architecture DMGs and manifests with a read-only token, verifies hashes, mounts and reports signatures/versions. It does not change releases, resign existing downloads or bypass quarantine. The comparison is diagnostic; a completed inspection does not mean the existing apps passed signature validation. Read its `releaseComparison` output.

## Local diagnosis on a Mac

Download from the authenticated private draft and choose arm64 for Apple Silicon or x64 for Intel. Compare `shasum -a 256 <download.dmg>` to that release's `SHA256SUMS.txt`. Use `hdiutil verify <download.dmg>` to check the disk image. After copying SSHDrop to Applications, run:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/SSHDrop.app
spctl --assess --type execute --verbose=4 /Applications/SSHDrop.app
```

These commands inspect; they do not disable Gatekeeper. Preserve the exact error output and macOS/chip version for diagnosis. Do not assume a matching download hash proves a valid signature or notarization. Developer ID signing, notarization and stapling remain required work for normal trusted public distribution.

## Storage policy

Ordinary CI runs for pull requests and main pushes; feature pushes are covered by their PR, with manual CI available before a PR. Successful checks retain no diagnostic artifact. Failed checks retain diagnostics for one day. Installer handoff artifacts between release jobs expire after one day; release assets remain separately attached to their private draft. The old diagnostic roundtrip job was removed because it existed only to verify always-uploaded diagnostics, not application correctness.

Historical `installers-*` Actions artifacts may be deleted only after verifying their corresponding completed release run and independent retained draft copies. Keep release installers/checksum files, and do not delete releases, tags or source history as storage cleanup. One release set is roughly 0.57 GiB, so six retained duplicate sets exceeded the account's 0.5 GB allowance. Deletion reduces current/future storage use but does not erase usage already accrued during the billing cycle. No billing settings or repository visibility changes are part of this fix.

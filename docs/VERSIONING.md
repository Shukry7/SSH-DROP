# Application versioning

The sole application version source is package.json. Electron reads it for the window and About information; electron-builder uses it for installer metadata and artifact names. package-lock.json, README.md, and CHANGELOG.md must match. CI checks these files and checks release tags against the version.

Use `X.Y.Z-alpha.N` for previews, followed by beta/rc stages as appropriate. Patch, minor, and major releases describe fixes, features, and breaking changes. During 0.x, describe breaking changes explicitly.

Run `npm run version:bump -- 0.2.0-alpha.3` (substitute the next intended version) to update the manifest, lockfile, README, and prepare a changelog entry together. Invalid, unchanged, and older versions are rejected. Move the completed Unreleased changes into the generated entry and date it before tagging; release checks reject an undated version entry. Several focused development commits can share one unreleased version.

For a release: merge the feature PRs, run all checks, commit completed metadata on a release branch, and merge its tested PR into main. Tag that exact main commit `v0.2.0-alpha.2` (substitute the exact version). The tag workflow creates a draft release with artifacts and checksums. A tag does not merge open PRs or change main, so verify ancestry before tagging. Review the draft and platform limitations before publishing. Never overwrite a published tag; ship a new version.

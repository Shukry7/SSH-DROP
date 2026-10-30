# Application versioning

The sole application version source is package.json. Electron reads it for the window and About information; electron-builder uses it for installer metadata and artifact names. package-lock.json, README.md, and CHANGELOG.md must match. CI checks these files and checks release tags against the version.

Use `0.1.0-alpha.N` for previews, followed by beta/rc stages as appropriate. Patch, minor, and major releases describe fixes, features, and breaking changes. During 0.x, describe breaking changes explicitly.

Run `npm run version:bump -- 0.1.0-alpha.2` to update the manifest, lockfile, README, and prepare a changelog entry together. Invalid, unchanged, and older versions are rejected. Finish and date the generated entry before tagging a release; release checks reject an Unreleased heading. Several focused development commits can share one unreleased version.

For a release: run all checks, commit completed metadata, and tag the tested commit `v0.1.0-alpha.1` (substitute the exact version). The tag workflow creates a draft release with artifacts and checksums. Review the draft and platform limitations before publishing. Never overwrite a published tag; ship a new version.

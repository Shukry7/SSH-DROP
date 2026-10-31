# Installing the SSHDrop alpha

SSHDrop is an early development preview. Evaluate it with disposable files and servers before trusting it with production work. Download published assets only from [the project's GitHub Releases](https://github.com/Shukry7/SSH-DROP/releases).

## Choose a build

| Computer            | Release artifact                       | Status                                                            |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Windows x64         | `SSHDrop-<version>-win-x64.exe`        | Unsigned NSIS installer                                           |
| macOS Apple Silicon | `SSHDrop-<version>-mac-arm64.dmg`      | Unsigned and not notarized                                        |
| macOS Intel         | `SSHDrop-<version>-mac-x64.dmg`        | Unsigned and not notarized                                        |
| Linux x64           | `SSHDrop-<version>-linux-x64.deb`      | Debian-family package; distribution compatibility needs testing   |
| Linux x64           | `SSHDrop-<version>-linux-x64.AppImage` | Experimental; FUSE and sandbox support depend on the distribution |

The tag workflow builds these formats and creates a draft release. Files become publicly downloadable when that draft is published. Passing CI does not certify every desktop environment or architecture.

Packaged builds include their runtime; end users do not need to install Node.js, npm, or the source dependencies. Installation and first launch do not require server credentials. SSH/SFTP must already be enabled on a server you are authorized to access.

## Verify the download

The release includes `SHA256SUMS.txt`. Compare your file's SHA-256 digest with its matching entry before opening it. Checksums detect a changed or incomplete download; they are not a substitute for a signed publisher identity.

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\SSHDrop-<version>-win-x64.exe'
```

macOS:

```sh
shasum -a 256 SSHDrop-<version>-mac-arm64.dmg
```

Linux, from the directory containing the downloaded files and checksum manifest:

```sh
sha256sum --check --ignore-missing SHA256SUMS.txt
```

Substitute the actual filename and version. A checksum mismatch means you should stop and obtain a fresh copy from the official release.

## Windows

Open the x64 `.exe` installer and choose the destination. Launch SSHDrop from the installed shortcut. Windows ARM64 and 32-bit builds are not currently provided.

The alpha is unsigned, so Windows can show an unknown-publisher or reputation warning. A download being available on GitHub does not establish a trusted Windows publisher. If your system or organization blocks it, use an approved development setup or wait for signed distribution; do not disable system security globally.

## macOS

Choose the DMG for your processor, open it, and copy SSHDrop to Applications. These alpha builds are unsigned and not notarized, so Gatekeeper can block first launch. Normal public distribution still requires signing and notarization work. If blocked, use the documented source development setup or wait for a signed build; do not disable Gatekeeper globally.

CI tests the runner's native architecture. Generating both Intel and Apple Silicon packages does not mean both have been manually tested on real Macs.

## Linux

On a compatible Debian/Ubuntu system, install the downloaded `.deb` through your software installer, or run:

```sh
sudo apt install ./SSHDrop-<version>-linux-x64.deb
```

For AppImage, give the file execute permission and run it:

```sh
chmod +x SSHDrop-<version>-linux-x64.AppImage
./SSHDrop-<version>-linux-x64.AppImage
```

AppImage requires compatible system libraries and may need FUSE support. Ubuntu 24.04 and other distributions can restrict the user namespaces needed by Chromium's sandbox. AppImage launch remains experimental on such systems. Do not use `--no-sandbox` or run SSHDrop as root to work around a launch failure. Report the distribution/version and error, or use a compatible packaged/development environment.

The CI AppArmor helper is specific to the disposable test runner and is not a supported end-user installation script.

## First connection and reporting issues

Use **New to SSH? Start here** and the **?** buttons for field explanations. Verify the server fingerprint through a trusted channel before accepting a new identity. Credentials are not persisted. The explorer's directory is independent of terminal `cd` commands.

Follow [MANUAL_TESTING.md](MANUAL_TESTING.md) for implemented behaviors and expected results. File reports through the repository's issue templates with app version, OS/architecture, and reproduction steps. Never include passwords, private keys, or sensitive remote files. See [SECURITY.md](../SECURITY.md) for security reports.

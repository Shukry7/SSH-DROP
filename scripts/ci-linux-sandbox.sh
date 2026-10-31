#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 24.04 restricts unprivileged user namespaces. Permit only the CI Electron
# binary to create its sandbox, without disabling Chromium's sandbox or changing
# the machine-wide AppArmor restriction. This runs only on disposable CI runners.
restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ -f "$restriction" ]] && [[ "$(cat "$restriction")" == 1 ]]; then
  temporary_profile="$(mktemp)"
  trap 'rm -f -- "$temporary_profile"' EXIT
  node scripts/linux-sandbox-profile.mjs "$temporary_profile"
  # Validate before replacing the installed profile. Keep sandboxing enabled.
  sudo apparmor_parser --skip-kernel-load "$temporary_profile"
  sudo install -m 0644 "$temporary_profile" /etc/apparmor.d/sshdrop-ci
  sudo apparmor_parser -r /etc/apparmor.d/sshdrop-ci
fi

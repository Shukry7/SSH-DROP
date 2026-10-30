#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 24.04 restricts unprivileged user namespaces. Permit only the CI Electron
# binary to create its sandbox, without disabling Chromium's sandbox or changing
# the machine-wide AppArmor restriction. This runs only on disposable CI runners.
restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ -f "$restriction" ]] && [[ "$(cat "$restriction")" == 1 ]]; then
  electron_binary="$(node -p "require('electron')")"
  sudo tee /etc/apparmor.d/sshdrop-ci >/dev/null <<PROFILE
abi <abi/4.0>,
include <tunables/global>
profile sshdrop-ci "$electron_binary" flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/sshdrop-ci
fi

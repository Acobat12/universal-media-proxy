#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ -f /etc/ump-update/config ]] || exit 0
# Config is installer-generated and root-only; never source arbitrary shell.
REPO=$(sed -n 's/^UMP_REPO=//p' /etc/ump-update/config | head -n1)
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
exec 9>/run/ump-update.lock
flock -n 9 || exit 0
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BASE="https://github.com/$REPO/releases/latest/download"
curl --fail --location --silent --show-error --retry 2 --max-time 90 "$BASE/ump-release.tar.gz" -o "$WORK/ump-release.tar.gz"
curl --fail --location --silent --show-error --retry 2 --max-time 30 "$BASE/ump-release.tar.gz.sha256" -o "$WORK/ump-release.tar.gz.sha256"
(cd "$WORK" && sha256sum -c ump-release.tar.gz.sha256)
# Require a safe source-only release layout. Reject links, absolute paths and traversal.
python3 - "$WORK/ump-release.tar.gz" <<'PY'
import sys,tarfile,pathlib
with tarfile.open(sys.argv[1],'r:gz') as t:
    members=t.getmembers()
    if len(members)>10000: raise SystemExit('too many entries')
    for m in members:
        p=pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()):
            raise SystemExit('unsafe tar entry: '+m.name)
        if not (m.name.startswith('src/') or m.name in ('package.json','package-lock.json')):
            raise SystemExit('unexpected release entry: '+m.name)
PY
mkdir -p "$WORK/new"
tar -xzf "$WORK/ump-release.tar.gz" -C "$WORK/new" --no-same-owner --no-same-permissions
[[ -f "$WORK/new/src/server.js" && -f "$WORK/new/package-lock.json" && -f "$WORK/new/package.json" ]] || exit 1
# Avoid restarting if the source is identical.
CURRENT=/opt/universal-media-proxy
NEW_HASH=$(sha256sum "$WORK/ump-release.tar.gz" | awk '{print $1}')
STATE=/var/lib/ump-update
install -d -m 0700 "$STATE"
[[ -f "$STATE/current.sha256" ]] && [[ $(cat "$STATE/current.sha256") == "$NEW_HASH" ]] && exit 0
# Install dependencies in isolated staging area; don't run package lifecycle scripts as root.
(cd "$WORK/new" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts)
node --check "$WORK/new/src/server.js"
BACKUP="$STATE/backup-$(date +%Y%m%d%H%M%S)"
install -d -m 0700 "$BACKUP"
cp -a "$CURRENT/src" "$CURRENT/package.json" "$CURRENT/package-lock.json" "$BACKUP/"
[[ -d "$CURRENT/node_modules" ]] && cp -a "$CURRENT/node_modules" "$BACKUP/"
rollback() {
  echo 'Update failed, rolling back' >&2
  rm -rf "$CURRENT/src" "$CURRENT/node_modules"
  cp -a "$BACKUP/src" "$BACKUP/package.json" "$BACKUP/package-lock.json" "$CURRENT/"
  [[ -d "$BACKUP/node_modules" ]] && cp -a "$BACKUP/node_modules" "$CURRENT/"
  systemctl restart universal-media-proxy || true
}
trap rollback ERR
rm -rf "$CURRENT/src" "$CURRENT/node_modules"
cp -a "$WORK/new/src" "$WORK/new/node_modules" "$WORK/new/package.json" "$WORK/new/package-lock.json" "$CURRENT/"
chown -R root:root "$CURRENT/src" "$CURRENT/node_modules" "$CURRENT/package.json" "$CURRENT/package-lock.json"
systemctl restart universal-media-proxy
sleep 3
systemctl is-active --quiet universal-media-proxy
printf '%s\n' "$NEW_HASH" > "$STATE/current.sha256"
trap - ERR
echo 'UMP update installed successfully'

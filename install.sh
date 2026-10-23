#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "Ошибка установки на строке $LINENO. Проверьте вывод выше." >&2' ERR
if [[ $EUID -ne 0 ]]; then echo 'Запустите: sudo bash install.sh'; exit 1; fi
if [[ ! -f src/server.js || ! -f package.json ]]; then echo 'Запускайте install.sh из папки проекта'; exit 1; fi
if ! command -v apt-get >/dev/null; then echo 'Автоустановка рассчитана на Ubuntu/Debian с apt'; exit 1; fi
if [[ -f /etc/universal-media-proxy.env ]]; then echo 'Установка уже существует: /etc/universal-media-proxy.env. Сделайте резервную копию и настройте вручную.'; exit 1; fi
read -rp 'Домен (например proxy.example.com) или IP сервера: ' TARGET
TARGET="${TARGET,,}"
if [[ ! "$TARGET" =~ ^[a-z0-9][a-z0-9.-]{0,251}$ ]] || [[ "$TARGET" == *..* ]] || [[ "$TARGET" == *. ]] ; then echo 'Некорректный домен/IP'; exit 1; fi
if [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  MODE=ip
  read -rp 'Порт HTTP для доступа по IP [3000]: ' PUBLIC_PORT
  PUBLIC_PORT="${PUBLIC_PORT:-3000}"
  if [[ ! "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || (( PUBLIC_PORT < 1024 || PUBLIC_PORT > 65535 )); then echo 'Порт должен быть 1024–65535'; exit 1; fi
  PUBLIC_URL="http://${TARGET}:${PUBLIC_PORT}"
  echo 'ВНИМАНИЕ: HTTP по IP не шифруется. Для VOT нужен доступный HTTPS URL.'
else
  MODE=domain
  PUBLIC_PORT=3000
  PUBLIC_URL="https://${TARGET}"
  echo 'Проверьте, что DNS A/AAAA домена указывает на этот VPS, а порты 80/443 открыты.'
  read -rp 'Продолжить установку HTTPS? [y/N]: ' CONFIRM
  [[ "$CONFIRM" =~ ^[YyДд]$ ]] || exit 1
fi
read -rp 'Включить VOT-прокси на этом же сервере? [y/N]: ' VOT_CONFIRM
VOT_ENABLED=false
if [[ "$VOT_CONFIRM" =~ ^[YyДд]$ ]]; then VOT_ENABLED=true; fi
read -rp 'Установить yt-dlp с официального GitHub и включить резервное извлечение для Bilibili? [Y/n]: ' YTDLP_CONFIRM
INSTALL_YTDLP=true
if [[ "$YTDLP_CONFIRM" =~ ^[NnНн]$ ]]; then INSTALL_YTDLP=false; fi
read -rp 'Лимит SSD-кэша в МиБ [1024]: ' CACHE_MB
CACHE_MB="${CACHE_MB:-1024}"
if [[ ! "$CACHE_MB" =~ ^[0-9]+$ ]] || (( CACHE_MB < 64 || CACHE_MB > 10240 )); then echo 'Лимит SSD: 64–10240 МиБ'; exit 1; fi
read -rp 'Установить Node.js 22 и системную службу? [Y/n]: ' INSTALL_CONFIRM
[[ ! "$INSTALL_CONFIRM" =~ ^[NnНн]$ ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg openssl python3
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  echo 'Устанавливается Node.js 22 из NodeSource (нужен интернет)'
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/ump-nodesource.sh
  bash /tmp/ump-nodesource.sh
  rm -f /tmp/ump-nodesource.sh
  apt-get install -y nodejs
fi
if [[ "$INSTALL_YTDLP" == true ]]; then
  echo 'Устанавливается yt-dlp из официальных GitHub Releases с проверкой SHA-256...'
  YTDLP_TMP="$(mktemp -d)"
  curl -fLsS --retry 3 --connect-timeout 15 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp' -o "$YTDLP_TMP/yt-dlp"
  curl -fLsS --retry 3 --connect-timeout 15 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS' -o "$YTDLP_TMP/SHA2-256SUMS"
  (cd "$YTDLP_TMP" && grep -E '^[0-9a-fA-F]{64} +\*?yt-dlp$' SHA2-256SUMS | sha256sum -c -) || { rm -rf "$YTDLP_TMP"; echo 'Проверка SHA-256 yt-dlp не пройдена'; exit 1; }
  install -m 0755 "$YTDLP_TMP/yt-dlp" /usr/local/bin/yt-dlp
  rm -rf "$YTDLP_TMP"
  /usr/local/bin/yt-dlp --version
fi
if [[ "$MODE" == domain ]]; then
  apt-get install -y caddy
fi
if ! id -u ump >/dev/null 2>&1; then useradd --system --home /opt/universal-media-proxy --shell /usr/sbin/nologin ump; fi
install -d -m 0755 /opt/universal-media-proxy /var/cache/universal-media-proxy
chown ump:ump /var/cache/universal-media-proxy
cp -a src package.json /opt/universal-media-proxy/
chown -R root:root /opt/universal-media-proxy
SECRET="$(openssl rand -hex 32)"
if [[ "$MODE" == ip ]]; then BIND=0.0.0.0; else BIND=127.0.0.1; fi
cat > /etc/universal-media-proxy.env <<ENV
HOST=$BIND
PORT=$PUBLIC_PORT
PUBLIC_BASE_URL=$PUBLIC_URL
ALLOWED_UPSTREAM_HOSTS=bilivideo.com,bilibili.com,hdslb.com
MAX_TRANSFER_BYTES=1073741824
MAX_CONCURRENT_STREAMS=2
ENABLE_YTDLP=$INSTALL_YTDLP
YTDLP_ALLOWED_HOSTS=bilibili.com
DEFAULT_AUDIO_MODE=disk
PARALLEL_THREADS=8
PARALLEL_CHUNK_BYTES=524288
DISK_CACHE_DIR=/var/cache/universal-media-proxy
DISK_CACHE_TTL_MS=900000
DISK_CACHE_MAX_BYTES=$((CACHE_MB * 1048576))
DISK_CACHE_MAX_FILE_BYTES=268435456
ENABLE_VOT_PROXY=$VOT_ENABLED
VOT_MAX_BODY_BYTES=1048576
ENV
chmod 0600 /etc/universal-media-proxy.env
cat > /etc/systemd/system/universal-media-proxy.service <<'UNIT'
[Unit]
Description=Universal Media Proxy
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=ump
Group=ump
WorkingDirectory=/opt/universal-media-proxy
EnvironmentFile=/etc/universal-media-proxy.env
ExecStart=/usr/bin/node /opt/universal-media-proxy/src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/cache/universal-media-proxy
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
if [[ "$MODE" == domain ]]; then
  if [[ -f /etc/caddy/Caddyfile ]]; then cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.ump-backup-$(date +%Y%m%d%H%M%S)"; fi
  cat > /etc/caddy/Caddyfile <<CADDY
$TARGET {
    reverse_proxy 127.0.0.1:3000
}
CADDY
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl restart caddy
fi
systemctl daemon-reload
systemctl enable --now universal-media-proxy
systemctl restart universal-media-proxy
sleep 2
systemctl is-active --quiet universal-media-proxy || { journalctl -u universal-media-proxy -n 50 --no-pager; exit 1; }
echo
echo "Установка завершена. Адрес: $PUBLIC_URL"
echo "yt-dlp: $INSTALL_YTDLP (разрешённые источники: bilibili.com)"
if [[ "$VOT_ENABLED" == true ]]; then echo "VOT API открыт без ключа: $PUBLIC_URL/vot"; fi
echo "Проверка: curl $PUBLIC_URL/health"
echo 'Логи: sudo journalctl -u universal-media-proxy -f'
echo 'Служба: sudo systemctl status universal-media-proxy'
echo 'Если домен ещё не направлен на сервер или закрыты 80/443, HTTPS заработает только после исправления DNS/сети.'

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
read -rp 'Установить Chromium для получения серверных cookies TikTok? [y/N]: ' TIKTOK_CONFIRM
INSTALL_TIKTOK_BROWSER=false
if [[ "$TIKTOK_CONFIRM" =~ ^[YyДд]$ ]]; then INSTALL_TIKTOK_BROWSER=true; fi
# Все параметры медиакеша настраиваются при установке.
read -rp 'Каталог медиакеша [/var/cache/universal-media-proxy/media]: ' MEDIA_CACHE_DIR
MEDIA_CACHE_DIR="${MEDIA_CACHE_DIR:-/var/cache/universal-media-proxy/media}"
if [[ "$MEDIA_CACHE_DIR" != /* || "$MEDIA_CACHE_DIR" == *$'\n'* || "$MEDIA_CACHE_DIR" == *$'\r'* || "$MEDIA_CACHE_DIR" == *' '* || "$MEDIA_CACHE_DIR" == *'..'* || "$MEDIA_CACHE_DIR" == *'='* ]]; then echo 'Некорректный абсолютный путь кеша'; exit 1; fi
read -rp 'Общий целевой лимит медиакеша, МиБ [1024]: ' CACHE_MB
CACHE_MB="${CACHE_MB:-1024}"
read -rp 'TTL медиакеша, минуты [15]: ' CACHE_TTL_MIN
CACHE_TTL_MIN="${CACHE_TTL_MIN:-15}"
read -rp 'Минимум свободного места на диске, МиБ [128]: ' CACHE_MIN_FREE_MB
CACHE_MIN_FREE_MB="${CACHE_MIN_FREE_MB:-128}"
read -rp 'Максимальный размер одного кешируемого файла, МиБ [256]: ' CACHE_FILE_MB
CACHE_FILE_MB="${CACHE_FILE_MB:-256}"
for spec in "CACHE_MB:64:1048576" "CACHE_TTL_MIN:1:10080" "CACHE_MIN_FREE_MB:0:1048576" "CACHE_FILE_MB:1:1048576"; do
  IFS=: read -r key lo hi <<< "$spec"
  value="${!key}"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < lo || 10#$value > hi )); then echo "Некорректное значение $key (допустимо $lo–$hi)"; exit 1; fi
done
# Порт SSH определяется по текущему соединению, но пользователь должен его подтвердить.
SSH_PORT_DEFAULT="$(awk '{print $4}' <<< "${SSH_CONNECTION:-}")"
if [[ ! "$SSH_PORT_DEFAULT" =~ ^[0-9]+$ ]] || (( SSH_PORT_DEFAULT < 1 || SSH_PORT_DEFAULT > 65535 )); then SSH_PORT_DEFAULT=22; fi
read -rp 'Настроить UFW: запретить новые входящие подключения, разрешить нужные порты? [y/N]: ' FIREWALL_CONFIRM
CONFIGURE_FIREWALL=false
if [[ "$FIREWALL_CONFIRM" =~ ^[YyДд]$ ]]; then
  CONFIGURE_FIREWALL=true
  read -rp "Порт SSH для сохранения доступа [$SSH_PORT_DEFAULT]: " SSH_PORT
  SSH_PORT="${SSH_PORT:-$SSH_PORT_DEFAULT}"
  if [[ ! "$SSH_PORT" =~ ^[0-9]+$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then echo 'Некорректный порт SSH'; exit 1; fi
  echo "Будут разрешены TCP: SSH $SSH_PORT и $(if [[ "$MODE" == domain ]]; then echo '80, 443'; else echo "$PUBLIC_PORT"; fi)."
  echo 'ВНИМАНИЕ: UFW действует на весь VPS, включая другие сервисы. Существующие правила не удаляются.'
  echo 'Если SSH использует дополнительные порты или VPS работает через Docker, проверьте правила вручную.'
  read -rp 'Подтвердить изменение межсетевого экрана? [y/N]: ' FW_APPLY_CONFIRM
  [[ "$FW_APPLY_CONFIRM" =~ ^[YyДд]$ ]] || CONFIGURE_FIREWALL=false
fi
# Опциональная защита и обновления. Ничего не меняем в SSH без проверки ключевого доступа.
read -rp 'Установить Fail2ban для защиты SSH? [Y/n]: ' F2B_CONFIRM
INSTALL_FAIL2BAN=true
[[ "$F2B_CONFIRM" =~ ^[NnНн]$ ]] && INSTALL_FAIL2BAN=false
read -rp 'Включить автоматические обновления безопасности ОС? [Y/n]: ' OS_UPDATES_CONFIRM
INSTALL_OS_UPDATES=true
[[ "$OS_UPDATES_CONFIRM" =~ ^[NnНн]$ ]] && INSTALL_OS_UPDATES=false
read -rp 'Разрешить автоматическую перезагрузку VPS при необходимости обновлений ОС? [y/N]: ' OS_REBOOT_CONFIRM
OS_AUTO_REBOOT=false
[[ "$OS_REBOOT_CONFIRM" =~ ^[YyДд]$ ]] && OS_AUTO_REBOOT=true
read -rp 'Включить дополнительную изоляцию systemd для UMP? [Y/n]: ' HARDEN_CONFIRM
HARDEN_SERVICE=true
[[ "$HARDEN_CONFIRM" =~ ^[NnНн]$ ]] && HARDEN_SERVICE=false
read -rp 'Включить автоматические обновления UMP из GitHub? [y/N]: ' UMP_UPDATE_CONFIRM
UMP_AUTO_UPDATES=false
UMP_REPO='Acobat12/universal-media-proxy'
UMP_UPDATE_HOURS=24
if [[ "$UMP_UPDATE_CONFIRM" =~ ^[YyДд]$ ]]; then
  echo 'Источник обновлений по умолчанию: https://github.com/Acobat12/universal-media-proxy'
  echo 'Вы можете указать свой публичный репозиторий GitHub. Устанавливайте обновления только из источников, которым доверяете.'
  read -rp 'Репозиторий GitHub [Acobat12/universal-media-proxy]: ' UMP_REPO_INPUT
  UMP_REPO="${UMP_REPO_INPUT:-Acobat12/universal-media-proxy}"
  # Supports owner/repo or an exact GitHub repository URL. Prevent arbitrary hosts and paths.
  UMP_REPO="${UMP_REPO#https://github.com/}"
  UMP_REPO="${UMP_REPO#http://github.com/}"
  UMP_REPO="${UMP_REPO%/}"
  [[ "$UMP_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9_.-]+$ ]] && [[ "$UMP_REPO" != *..* ]] || { echo 'Некорректный GitHub owner/repo'; exit 1; }
  if ! curl --fail --location --silent --show-error --connect-timeout 10 --max-time 20 "https://api.github.com/repos/$UMP_REPO" -o /dev/null; then
    echo 'GitHub-репозиторий недоступен или не является публичным. Автообновление не включено.' >&2
    exit 1
  fi
  echo 'Для обновлений нужны опубликованные GitHub Releases с файлами ump-release.tar.gz и ump-release.tar.gz.sha256.'
  read -rp 'Интервал проверки, часы [24]: ' UMP_UPDATE_HOURS
  UMP_UPDATE_HOURS="${UMP_UPDATE_HOURS:-24}"
  [[ "$UMP_UPDATE_HOURS" =~ ^[0-9]+$ ]] && (( UMP_UPDATE_HOURS >= 1 && UMP_UPDATE_HOURS <= 168 )) || { echo 'Интервал 1–168 часов'; exit 1; }
  UMP_AUTO_UPDATES=true
fi
read -rp 'Установить Node.js 22 и системную службу? [Y/n]: ' INSTALL_CONFIRM
[[ ! "$INSTALL_CONFIRM" =~ ^[NnНн]$ ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg openssl python3 ffmpeg
if [[ "$INSTALL_FAIL2BAN" == true ]]; then apt-get install -y fail2ban; fi
if [[ "$INSTALL_OS_UPDATES" == true ]]; then apt-get install -y unattended-upgrades; fi
if [[ "$CONFIGURE_FIREWALL" == true ]]; then
  echo 'Проверка UFW: установка пакета при отсутствии на чистой системе...'
  if ! command -v ufw >/dev/null 2>&1; then
    apt-get install -y ufw
  fi
  command -v ufw >/dev/null 2>&1 || { echo 'UFW не удалось установить; правила не применены.' >&2; exit 1; }
  ufw version
fi
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
# Системному пользователю не нужен пароль и интерактивная оболочка.
usermod -s /usr/sbin/nologin ump
passwd -l ump >/dev/null 2>&1 || true
install -d -m 0755 /opt/universal-media-proxy /var/cache/universal-media-proxy
install -d -m 0750 "$MEDIA_CACHE_DIR"
chown ump:ump "$MEDIA_CACHE_DIR"
chown ump:ump /var/cache/universal-media-proxy
cp -a src package.json package-lock.json /opt/universal-media-proxy/
chown -R root:root /opt/universal-media-proxy
(
  cd /opt/universal-media-proxy
  # Playwright уже зафиксирован в package-lock.json.
  # Установка npm-пакетов не должна автоматически загружать браузер.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
  if [[ "$INSTALL_TIKTOK_BROWSER" == true ]]; then
    echo 'Устанавливаются системные зависимости и Chromium для TikTok...'
    ./node_modules/.bin/playwright install-deps chromium
    install -d -m 0755 /opt/universal-media-proxy/.cache/ms-playwright
    PLAYWRIGHT_BROWSERS_PATH=/opt/universal-media-proxy/.cache/ms-playwright ./node_modules/.bin/playwright install chromium
    chmod -R a+rX /opt/universal-media-proxy/.cache/ms-playwright
  fi
)

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
TIKTOK_REGISTRATIONS_FILE=/var/cache/universal-media-proxy/tiktok-registrations.json
TIKTOK_PROFILE_DIR=/var/cache/universal-media-proxy/tiktok-profile
TIKTOK_MAX_PAGES=2
DISK_CACHE_DIR=$MEDIA_CACHE_DIR
DISK_CACHE_TTL_MS=$((CACHE_TTL_MIN * 60000))
DISK_CACHE_MAX_BYTES=$((CACHE_MB * 1048576))
DISK_CACHE_MAX_FILE_BYTES=$((CACHE_FILE_MB * 1048576))
DISK_CACHE_MIN_FREE_BYTES=$((CACHE_MIN_FREE_MB * 1048576))
ENABLE_VOT_PROXY=$VOT_ENABLED
ENABLE_TIKTOK_BROWSER=$INSTALL_TIKTOK_BROWSER
PLAYWRIGHT_BROWSERS_PATH=/opt/universal-media-proxy/.cache/ms-playwright
VOT_MAX_BODY_BYTES=1048576
ENV
chmod 0600 /etc/universal-media-proxy.env
cat > /etc/systemd/system/universal-media-proxy.service <<UNIT
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
ReadWritePaths=/var/cache/universal-media-proxy $MEDIA_CACHE_DIR
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
# Усиление службы не должно запрещать запись в профили и кеши адаптеров.
if [[ "$HARDEN_SERVICE" == true ]]; then
  install -d -m 0755 /etc/systemd/system/universal-media-proxy.service.d
  cat > /etc/systemd/system/universal-media-proxy.service.d/security.conf <<'SECURITY'
[Service]
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
LockPersonality=true
RestrictRealtime=true
SECURITY
fi
if [[ "$INSTALL_FAIL2BAN" == true ]]; then
  install -d -m 0755 /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/ump-sshd.local <<'FAIL2BAN'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
FAIL2BAN
  systemctl enable --now fail2ban
  systemctl restart fail2ban
fi
if [[ "$INSTALL_OS_UPDATES" == true ]]; then
  install -d -m 0755 /etc/apt/apt.conf.d
  cat > /etc/apt/apt.conf.d/52ump-security-updates <<APTUPDATES
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "$OS_AUTO_REBOOT";
APTUPDATES
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
fi
if [[ "$UMP_AUTO_UPDATES" == true ]]; then
  install -m 0750 scripts/ump-update.sh /usr/local/sbin/ump-update
  install -d -m 0700 /etc/ump-update
  printf 'UMP_REPO=%s\n' "$UMP_REPO" > /etc/ump-update/config
  chmod 0600 /etc/ump-update/config
  cat > /etc/systemd/system/ump-update.service <<'UPDATEUNIT'
[Unit]
Description=Check signed-source UMP GitHub release and update UMP
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ump-update
UPDATEUNIT
  cat > /etc/systemd/system/ump-update.timer <<UPDATETIMER
[Unit]
Description=Periodically check for UMP releases
[Timer]
OnBootSec=15min
OnUnitInactiveSec=${UMP_UPDATE_HOURS}h
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
UPDATETIMER
  systemctl daemon-reload
  systemctl enable --now ump-update.timer
fi
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
# Без сброса существующих правил: это безопаснее для VPS с другими сервисами.
if [[ "$CONFIGURE_FIREWALL" == true ]]; then
  ufw allow "$SSH_PORT/tcp" comment 'UMP preserve SSH'
  if [[ "$MODE" == domain ]]; then
    ufw allow 80/tcp comment 'UMP HTTP certificate'
    ufw allow 443/tcp comment 'UMP HTTPS'
  else
    ufw allow "$PUBLIC_PORT/tcp" comment 'UMP HTTP'
  fi
  ufw default deny incoming
  ufw default allow outgoing
  # Никакого ufw reset: не уничтожать правила других приложений.
  ufw --force enable
  ufw status verbose
fi
systemctl daemon-reload
systemctl enable --now universal-media-proxy
systemctl restart universal-media-proxy
sleep 2
systemctl is-active --quiet universal-media-proxy || { journalctl -u universal-media-proxy -n 50 --no-pager; exit 1; }
echo
echo "Установка завершена. Адрес: $PUBLIC_URL"
echo "yt-dlp: $INSTALL_YTDLP (разрешённые источники: bilibili.com)"
echo "Chromium для TikTok: $INSTALL_TIKTOK_BROWSER"
echo "Медиакеш: $MEDIA_CACHE_DIR, лимит ${CACHE_MB} МиБ, TTL ${CACHE_TTL_MIN} мин, свободно минимум ${CACHE_MIN_FREE_MB} МиБ"
echo "UFW настроен: $CONFIGURE_FIREWALL"
echo "Fail2ban: $INSTALL_FAIL2BAN; обновления ОС: $INSTALL_OS_UPDATES; авто-reboot VPS: $OS_AUTO_REBOOT"
echo "Изоляция systemd: $HARDEN_SERVICE; проверка релизов UMP: $UMP_AUTO_UPDATES"
if [[ "$VOT_ENABLED" == true ]]; then echo "VOT API открыт без ключа: $PUBLIC_URL/vot"; fi
echo "Проверка: curl $PUBLIC_URL/health"
echo 'Логи: sudo journalctl -u universal-media-proxy -f'
echo 'Служба: sudo systemctl status universal-media-proxy'
echo 'Если домен ещё не направлен на сервер или закрыты 80/443, HTTPS заработает только после исправления DNS/сети.'

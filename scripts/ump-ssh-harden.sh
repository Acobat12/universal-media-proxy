#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Запустите с sudo/root' >&2; exit 1; }
[[ -s /root/.ssh/authorized_keys ]] || { echo 'Нет ключей root; отмена' >&2; exit 1; }
echo 'Сначала подтвердите вход в НОВОЙ SSH-сессии по ключу (без пароля root).'
read -rp 'Вы лично проверили такой вход? Напишите YES: ' ANSWER
[[ "$ANSWER" == YES ]] || { echo 'Отмена'; exit 1; }
command -v sshd >/dev/null || { echo 'sshd не найден'; exit 1; }
# Use the main configuration rather than an unverified drop-in: some distributions
# put Include directives after existing PasswordAuthentication entries.
CONF=/etc/ssh/sshd_config
[[ -f "$CONF" ]] || { echo 'Нет sshd_config'; exit 1; }
BACKUP="$(mktemp /etc/ssh/sshd_config.ump-backup.XXXXXX)"
cp -p "$CONF" "$BACKUP"
restore() {
  cp -p "$BACKUP" "$CONF"
  echo "Настройки SSH восстановлены из $BACKUP" >&2
}
# Insert before Match blocks and before other config directives.
TMP="$(mktemp)"
{
  printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n'
  cat "$CONF"
} > "$TMP"
cat "$TMP" > "$CONF"
rm -f "$TMP"
if ! sshd -t; then restore; exit 1; fi
EFFECTIVE="$(sshd -T)"
if ! grep -qx 'passwordauthentication no' <<< "$EFFECTIVE" ||
   ! grep -qx 'permitrootlogin prohibit-password' <<< "$EFFECTIVE" ||
   ! grep -qx 'pubkeyauthentication yes' <<< "$EFFECTIVE"; then
  restore
  echo 'Эффективная конфигурация не соответствует ожидаемой (проверьте Include/Match)' >&2
  exit 1
fi
if ! systemctl reload ssh.service 2>/dev/null && ! systemctl reload sshd.service 2>/dev/null; then
  restore
  echo 'Не удалось перезагрузить sshd; изменения откатили' >&2
  exit 1
fi
echo 'Вход по паролю отключён; root может входить только по ключу.'
echo "Резервная копия конфигурации: $BACKUP"
echo 'Не закрывайте текущую сессию, пока не проверите новое подключение.'

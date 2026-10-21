# Публичный VOT API без ключа

VOT API доступен всем по адресу `https://media-proxy.mooo.com/vot` без заголовка `X-Proxy-Key`.
Авторизация Media Proxy (`/api/resolve`) также удалена: API-ключ не требуется.

## Обновление уже установленного сервера

Этот архив сам по себе не меняет работающий VPS. Скопируйте обновлённые `src/server.js` и `src/vot-gateway.js` в `/opt/universal-media-proxy/src/`, затем выполните:

```bash
sudo systemctl restart universal-media-proxy
sudo systemctl is-active universal-media-proxy
curl -i -X POST https://media-proxy.mooo.com/vot/video-translation/translate -H 'Content-Type: application/json' --data '{}'
```

Запрос не должен получать 401 из-за отсутствия ключа. JSON `{}` не проверяет работоспособность перевода.
Для чистой установки используйте обновлённый `install.sh`.
Удаление старой переменной `VOT_PROXY_API_KEY` из `/etc/universal-media-proxy.env` необязательно: новая версия её игнорирует.

Важно: у VOT по-прежнему есть ограничение на размер тела запроса `VOT_MAX_BODY_BYTES`; ограничение частоты запросов в шлюзе не добавлено.

## Совместимый клиент VOT (актуальный образец)

Полный пример: [`docs/reference/protobufEnvelopeProvider.ts`](docs/reference/protobufEnvelopeProvider.ts) — копия предоставленного `protobufEnvelopeProvider(3).ts`.

Клиент должен отправлять `application/x-vot-envelope+protobuf`, включая разрешённые исходные заголовки, бинарное тело и внутренний путь без `/vot`.

- VPS UMP: базовый адрес `https://media-proxy.mooo.com/vot`.
- Самостоятельный Cloudflare Worker: `https://fork.workers-vot.workers.dev` (без `/vot`).

Префикс `/vot` нужен **только** внешнему маршруту UMP. Внутри Envelope используется `/video-translation/translate` или иной оригинальный путь API. Не копируйте клиентский `.ts` вместо `src/vot-worker.js`.

Проверка: запрос перевода с одинаковым SHA-256 бинарного тела получал HTTP 200 через Cloudflare и HTTP 402 через VPS. Это подтверждает обработку Envelope, но не доказывает причину 402 и не гарантирует успешный перевод с любого VPS.

# Настройка адреса UMP в форке VOT

Сервер указывается в настройках VOT. Метод `initVOTClient()` в `src/index.ts` уже читает `proxyWorkerHost` и выбирает `VOTProtobufEnvelopeClient` при пресете `ump-protobuf` или `custom`. Изменять `src/index.ts` и `src/config/config.ts` для смены адреса не требуется.

Для Bilibili тот же адрес должен быть указан в `BilibiliHelper.registerProxyVideo()` (`proxyBase`) и в `protobufEnvelopeProvider.ts` (`BILIBILI_MEDIA_ORIGIN`). Пример настройки и проверка: [VOT_CODE_CHANGES_RU.md](VOT_CODE_CHANGES_RU.md).

Не добавляйте `/vot` во внутреннее поле `path` Protobuf Envelope: оно содержит `/video-translation/translate`.

# Проверка интеграции VOT

- [ ] В настройках VOT выбран UMP и указан адрес своего сервера.
- [ ] В `BilibiliHelper.registerProxyVideo()` установлен тот же адрес (`proxyBase`).
- [ ] В `protobufEnvelopeProvider.ts` установлен тот же адрес (`BILIBILI_MEDIA_ORIGIN`).
- [ ] `src/index.ts` не требует изменений.
- [ ] `BilibiliHelper` зарегистрирован в реестре Helpers VOT.
- [ ] `isCustomLink()` пропускает Bilibili `.m4a` через Protobuf-клиент.
- [ ] Запрос перевода использует `application/x-vot-envelope+protobuf`.
- [ ] Работают Range (206), перевод и звук Bilibili.
- [ ] Douyin и прямой API Яндекса работают как прежде.

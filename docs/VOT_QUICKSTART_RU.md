# Настройка VOT для Universal Media Proxy

1. В `src/index.ts` проверьте выбор `VOTProtobufEnvelopeClient` в `initVOTClient()` для Bilibili и UMP. Существующие маршруты Douyin и Яндекса не меняйте.
2. Зарегистрируйте `BilibiliHelper` в реестре Helpers VOT. Helper должен возвращать зарегистрированный на UMP `mediaUrl`.
3. В `src/videoHandler/modules/protobufEnvelopeProvider.ts` оставьте переопределение `isCustomLink()` для URL `/media/bilibili/.../audio.m4a`.
4. Соберите userscript и проверьте заголовок `application/x-vot-envelope+protobuf`, перевод, HTTP Range и звук.

Подробности: [VOT_CODE_CHANGES_RU.md](VOT_CODE_CHANGES_RU.md).

# Подключение UMP к VOT

## Адрес сервера

Перед использованием укажите адрес своего UMP-сервера в трёх местах:

1. В настройках VOT выберите сервер UMP (пресет `ump-protobuf` или `custom`) и задайте адрес своего сервера. `src/index.ts` менять не нужно: `initVOTClient()` уже получает хост из настроек.
2. В `BilibiliHelper`, в методе `registerProxyVideo(bvid, page)`, замените `const proxyBase = "https://media-proxy.org";` на адрес своего сервера без завершающего `/`.
3. В `src/videoHandler/modules/protobufEnvelopeProvider.ts` замените `BILIBILI_MEDIA_ORIGIN` на тот же адрес сервера. Это проверка URL медиа Bilibili в `isCustomLink()`.

Во всех трёх местах должен использоваться один и тот же сервер. В примерах `https://media-proxy.org` — адрес-заглушка, а не готовый сервер.

## Проверка подключения

1. Зарегистрируйте `BilibiliHelper` в реестре VOT.
2. Убедитесь, что в `protobufEnvelopeProvider.ts` проверяется адрес вашего UMP.
3. Соберите userscript и проверьте перевод, звук и `Content-Type: application/x-vot-envelope+protobuf`.
4. Проверьте, что Douyin и прямой маршрут Яндекса продолжают работать.

Подробности: [VOT_CODE_CHANGES_RU.md](VOT_CODE_CHANGES_RU.md).

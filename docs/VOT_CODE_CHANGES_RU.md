# Интеграция Universal Media Proxy в VOT

Эта инструкция относится к форку VOT, в котором используются `VideoHandler.initVOTClient()`, `VOTProtobufEnvelopeClient` и Helper-адаптеры сайтов.

## Клиент Protobuf

Файл `src/videoHandler/modules/protobufEnvelopeProvider.ts` содержит `VOTProtobufEnvelopeClient extends VOTClient`. Метод `request()` упаковывает бинарный запрос и допустимые заголовки в Envelope. Внешний запрос отправляется с `Content-Type: application/x-vot-envelope+protobuf`; внутренний путь — `/video-translation/translate`, без `/vot`.

В `src/index.ts` метод `initVOTClient()` выбирает `VOTProtobufEnvelopeClient` для UMP. Для Bilibili используется `media-proxy.freedynamicdns.org`. Остальные ветки выбора клиента, включая Douyin и прямой `api.browser.yandex.ru`, не заменять.

## Регистрация Bilibili

Клиентский `BilibiliHelper` должен быть зарегистрирован в действующем реестре Helpers VOT и подключён к определению сайта. Пример реализации: [`reference/bilibili-helper-user-example.js`](reference/bilibili-helper-user-example.js).

В `getVideoData()` Helper получает BVID и номер страницы, вызывает `POST https://media-proxy.freedynamicdns.org/api/bilibili/register` с JSON `{ bvid, page }`, проверяет `mediaUrl` и возвращает его как `videoData.url`. Для обычного видео путь имеет вид `/media/bilibili/<BVID>/p<PAGE>/audio.m4a`.

Серверный адаптер `src/adapters/bilibili.js` отвечает за получение и выдачу медиа. Его регистрация на сервере не заменяет регистрацию Helper в VOT.

## Обязательное исключение для `.m4a`

В используемой версии `@vot.js/core` метод `isCustomLink()` распознаёт `.m4a` как пользовательский медиафайл. Тогда `translateVideo()` выбирает `translateVideoVOTImpl()` → `requestVOT()`, который отправляет JSON и не вызывает переопределённый `request()`.

Для Bilibili в `VOTProtobufEnvelopeClient` должен быть метод:

```ts
override isCustomLink(url: string): boolean {
  const isBilibiliPage =
    typeof location !== "undefined" &&
    /(?:^|\.)bilibili\.com$/i.test(location.hostname);
  const isBilibiliMedia =
    /^https:\/\/media-proxy\.freedynamicdns\.org\/media\/bilibili\//i.test(url);

  if (isBilibiliPage && isBilibiliMedia) {
    return false;
  }
  return super.isCustomLink(url);
}
```

Исключение действует только для медиа Bilibili на указанном UMP-хосте. Для других URL остаётся стандартная логика библиотеки. Образец полного клиента: [`reference/protobufEnvelopeProvider.ts`](reference/protobufEnvelopeProvider.ts).

## Добавление нового сайта

1. Создать серверный адаптер по действующим адаптерам `src/adapters/bilibili.js` и `src/adapters/douyin.js`.
2. Создать клиентский Helper по структуре актуальных Helper-адаптеров этого форка VOT. Зарегистрировать Helper в реестре и добавить распознавание сайта и плеера.
3. Если сайт использует регистрацию медиа, реализовать соответствующий endpoint на UMP и вызов из `getVideoData()`. Возвращать проверенный `mediaUrl`.
4. Проверить, какой путь выбирает `VOTClient.translateVideo()` для `mediaUrl`. Если `isCustomLink()` ведёт к `requestVOT()` с JSON, добавить ограниченное исключение для данного сайта в `protobufEnvelopeProvider.ts`.
5. Проверить, что `initVOTClient()` выбирает Protobuf-клиент для этого сайта, не меняя маршруты других сайтов.

## Проверка

- В консоли при переводе Bilibili появляется `[FORK][protobuf-envelope]`.
- Запрос к UMP содержит `Content-Type: application/x-vot-envelope+protobuf`, а не `application/json`.
- URL `/media/bilibili/.../audio.m4a` поддерживает HTTP Range (206).
- Работают перевод и звук Bilibili, а также ранее работающий Douyin.
- Прямой маршрут `api.browser.yandex.ru` сохранён.

Серверные маршруты `/vot/*` публичной версии не требуют `VOT_PROXY_API_KEY` или `X-Proxy-Key`.

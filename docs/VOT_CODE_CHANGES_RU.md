# Подключение UMP к VOT

## Адрес сервера

Перед использованием укажите адрес своего UMP-сервера в трёх местах:

1. В настройках VOT выберите сервер UMP (пресет `ump-protobuf` или `custom`) и задайте адрес своего сервера. `src/index.ts` менять не нужно: `initVOTClient()` уже получает хост из настроек.
2. В `BilibiliHelper`, в методе `registerProxyVideo(bvid, page)`, замените `const proxyBase = "https://media-proxy.org";` на адрес своего сервера без завершающего `/`.
3. В `src/videoHandler/modules/protobufEnvelopeProvider.ts` замените `BILIBILI_MEDIA_ORIGIN` на тот же адрес сервера. Это проверка URL медиа Bilibili в `isCustomLink()`.

Во всех трёх местах должен использоваться один и тот же сервер. В примерах `https://media-proxy.org` — адрес-заглушка, а не готовый сервер.

## Bilibili Helper

Зарегистрируйте `BilibiliHelper` в реестре Helpers VOT и подключите распознавание страниц Bilibili. Метод `registerProxyVideo(bvid, page)` отправляет `POST /api/bilibili/register` с JSON `{ bvid, page }` и получает `mediaUrl` вида `/media/bilibili/<BVID>/p<PAGE>/audio.m4a`. Проверяйте происхождение и путь возвращённого URL.

Пример: [`reference/bilibili-helper-user-example.js`](reference/bilibili-helper-user-example.js).

## Обработка Bilibili `.m4a`

`@vot.js/core` считает `.m4a` пользовательской медиа-ссылкой и может выбрать `translateVideoVOTImpl()` с JSON-запросом. UMP ожидает Protobuf Envelope. В `VOTProtobufEnvelopeClient` исключение должно применяться только к Bilibili и URL медиа на выбранном сервере:

```ts
const BILIBILI_MEDIA_ORIGIN = "https://media-proxy.org"; // замените на свой сервер

override isCustomLink(url: string): boolean {
  const isBilibiliPage =
    typeof location !== "undefined" &&
    /(?:^|\.)bilibili\.com$/i.test(location.hostname);
  let isBilibiliMedia = false;
  try {
    const parsed = new URL(url);
    isBilibiliMedia = parsed.origin === BILIBILI_MEDIA_ORIGIN &&
      parsed.pathname.startsWith("/media/bilibili/");
  } catch { /* некорректный URL */ }
  if (isBilibiliPage && isBilibiliMedia) return false;
  return super.isCustomLink(url);
}
```

Образец клиента: [`reference/protobufEnvelopeProvider.ts`](reference/protobufEnvelopeProvider.ts).

## Проверка

- При выборе UMP используется `VOTProtobufEnvelopeClient`.
- Перевод отправляется с `Content-Type: application/x-vot-envelope+protobuf`, а не JSON.
- URL `/media/bilibili/.../audio.m4a` отдаёт HTTP 206 для Range-запросов.
- Работают перевод и звук Bilibili; маршруты Douyin и прямого API Яндекса не затронуты.

## Новый сайт

Для нового сайта добавьте серверный адаптер UMP и клиентский Helper в VOT. Helper зарегистрируйте в действующем реестре. Проверьте выбор клиента и ветку `isCustomLink()` для возвращаемого медиа URL. Исключения добавляйте только для конкретного сайта и доверенного адреса сервера.

> **Обновление публичной версии:** сервер VOT больше не требует `VOT_PROXY_API_KEY` или `X-Proxy-Key`. Упоминания проверки ключа ниже относятся к прежней защищённой версии.

# Изменения VOT для Universal Media Proxy — проверено по voice-over-translation-master

> Это **инструкция по внесению изменений в существующий код**, а не предложение заменить файлы. Конкретный пример изменений для загруженного `voice-over-translation-master(11).zip` дан в [`VOT_REFERENCE_CHANGES.patch`](VOT_REFERENCE_CHANGES.patch). В другой версии ищите соответствующие функции, а не копируйте файлы целиком.

## Важный вывод по совместимости

**Для текущего сервера выбирайте режим 3 (Protobuf Envelope).** Обычный `VOTNextWorkerProvider` в режиме 2 не гарантирует совместимость с серверным обработчиком: сервер ожидает `application/x-vot-envelope+protobuf` либо отдельную двухшаговую передачу метаданных. Одного перенаправления адреса недостаточно.

**Актуальная публичная версия сервера:** маршруты `/vot/*` не требуют `VOT_PROXY_API_KEY` и `X-Proxy-Key`. Не добавляйте эти заголовки в открытый клиент. Публичный прокси следует защищать от злоупотреблений средствами контроля доступа и ограничения нагрузки на инфраструктуре.

**Эталон клиентского файла (с исправлением маршрута Bilibili `.m4a`):** [`reference/protobufEnvelopeProvider.ts`](reference/protobufEnvelopeProvider.ts) — точная копия предоставленного `protobufEnvelopeProvider(3).ts`. При интеграции сверяйте импорт `VOTClient`, метод `getOpts()` и маршрутизацию с конкретной версией форка.

## 1. Найдите тип режима прокси

В проверенном VOT: `src/types/storage.ts`, тип `TranslateProxyStatus`. Измените:

```ts
export type TranslateProxyStatus = 0 | 1 | 2 | 3;
```

`0` — прямой Яндекс; `1` — предустановленный Worker; `2` — обычный пользовательский Worker; `3` — собственный сервер с Protobuf Envelope.

## 2. Найдите выпадающий список настроек

В проверенном VOT: `src/components/Settings/SettingsProxySection.tsx`. В массиве `proxyEnabledLabels` добавьте четвёртый элемент:

```ts
const proxyEnabledLabels = [
  t("VOTTranslateProxyDisabled"),
  t("VOTTranslateProxyEnabled"),
  t("VOTTranslateProxyEverything"),
  "Protobuf Envelope (свой VPS)",
];
```

Список строится через индекс массива, поэтому новый пункт получает значение `3`. Если в вашей версии используются явные значения, задайте `value: 3`. Для локализации вместо строки добавьте ключ перевода во все нужные локали и типы.

## 3. Добавьте Protobuf Envelope провайдер

Эталон для текущего форка: [`docs/reference/protobufEnvelopeProvider.ts`](reference/protobufEnvelopeProvider.ts). Это **клиентский**, а не серверный файл. Он реализует `VOTProtobufEnvelopeClient extends VOTClient` и переопределяет `request()`:

- формирует Envelope из разрешённых заголовков, исходного бинарного тела и пути;
- получает эффективные заголовки через `this.getOpts(new Blob([body]), headers, method)` и сохраняет явно переданные подписанные заголовки;
- отправляет Envelope с `Content-Type: application/x-vot-envelope+protobuf`;
- сохраняет внутренний путь `/video-translation/translate` **без** `/vot`.

Внешний путь для Universal Media Proxy: `https://media-proxy.mooo.com/vot/video-translation/translate`. Для отдельного Cloudflare Worker: `https://fork.workers-vot.workers.dev/video-translation/translate` (без `/vot`). Префикс добавляется при построении URL выбранного прокси, а не при упаковке Envelope.

**Не заменяйте** серверный `src/vot-worker.js` этим TypeScript-файлом. Сервер принимает Envelope, восстанавливает разрешённые заголовки и тело, после чего пересылает запрос к API Яндекса. Код образца нельзя автоматически переносить в форк другой версии без проверки интерфейса `VOTClient`.

## 4. Подключите провайдер при создании VOT-клиента

В проверенном VOT: `src/VideoHandler.ts`, метод `buildVOTClient()`. Импортируйте новый класс и замените выбор `provider`:

```ts
provider: this.data?.translateProxyEnabled === 3
  ? VOTProtobufEnvelopeClient
  : proxyClientEnabled ? VOTNextWorkerProvider : YandexProvider,
```

Оставьте существующую инициализацию сессий, защиту от повторного создания клиента, обработчики событий и остальной код без изменений.

## 5. Включите аудио и субтитры в режиме 3

Найдите функцию, проверяющую режим полного проксирования. В проверенном VOT она находится в `src/videoHandler/modules/proxyShared.ts`:

```ts
function isProxyRoutingEnabled(config: ProxyConfig): boolean {
  return config.translateProxyEnabled === 2 || config.translateProxyEnabled === 3;
}
```

Функции `proxifyYandexAudioUrl` и `proxifyYandexSubtitlesUrl` уже существуют — их не нужно создавать повторно. Убедитесь, что они добавляют к домену **ровно один** `/vot`, а `unproxifyYandexAudioUrl` корректно понимает URL с префиксом `/vot`.

## 6. Нормализуйте адрес прокси

В проверенном VOT используется `resolveProxyWorkerHost`. Он должен возвращать `domain.example/vot` без протокола и завершающего `/`. Пример исправления приведён в патче. Это предотвращает URL вида `https://https://domain.example/vot/...` и двойные слеши.

В настройках VOT укажите:

```text
YOUR_DOMAIN/vot
```

Не вводите `https://` в поле, если клиент сам добавляет его при сборке URL. Проверьте эту особенность в своей версии VOT.

## 7. Обновите учёт режимов и разрешения

В проверенном VOT массив `PROXY_MODES` в `src/modules/telemetry/context.ts` рассчитан на три режима — добавьте четвёртое имя. Это исправление аналитики, не маршрутизации.

Для userscript проверьте `@connect YOUR_DOMAIN` в метаданных и права GM XHR. Для браузерного расширения проверьте `host_permissions` и правила CORS/фонового сетевого доступа. Путь к настройке зависит от варианта сборки.

## 8. Как проверить

1. Сначала запустите серверные тесты `node --test`.
2. В клиенте запустите доступную команду проверки типов и сборки (для предоставленного проекта: `bun run check`, `bun run build:gm`), установив зависимости.
3. В Network найдите POST на `https://YOUR_DOMAIN/vot/video-translation/translate` с `application/x-vot-envelope+protobuf`.
4. Если ответ **401**, проверьте фактическую конфигурацию доступа: публичная версия сервера не требует `X-Proxy-Key`.
5. Если ответ **400**, проверьте бинарное тело, внутренний путь и заголовки.
6. Если **404**, проверьте `/vot` и маршруты.
7. Отдельно проверьте аудио и субтитры. Успешные тесты сервера не подтверждают реальный перевод Яндекса.

## Что ещё НЕ подтверждено

Патч относится к более раннему варианту клиента и может отличаться от актуального эталонного файла. В текущих проверках Cloudflare Worker получил HTTP 200, а VPS — HTTP 402 при совпадении SHA-256 тела и имён заголовков. Причина HTTP 402 не установлена. Полная поддержка произвольных версий VOT не гарантируется. Защита публичного сервера требует отдельного безопасного решения до публичного развёртывания.


## Дополнение: регистрация Helper и регрессия `.m4a`


## Обязательные части интеграции нового сайта: серверный адаптер + VOT Helper + транспорт

**Серверный адаптер не равен клиентскому Helper.** Файл `src/adapters/<site>.js`
в Universal Media Proxy регистрируется загрузчиком серверных адаптеров. Он отвечает
за разрешение медиа, доверенные CDN, постоянные URL и, при необходимости,
`prepareMediaTranslation()`. Сам по себе он **не добавляет поддержку сайта в VOT**.

**Клиентский Helper** добавляется в исходники форка VOT по образцу
[`docs/reference/bilibili-helper-user-example.js`](../docs/reference/bilibili-helper-user-example.js)
(реальный предоставленный пример). В зависимости от структуры версии VOT
нужно:

1. Создать Helper нового сайта на основе существующих **новых** Helper-адаптеров
   этой же версии VOT, сохранив актуальные методы, возвращаемые поля и соглашения.
   Не копировать целиком старый Helper из другой версии.
2. Зарегистрировать Helper в фабрике/реестре Helpers VOT, подключить определение
   домена/сайта и необходимые селекторы плеера. Найти реальные файлы регистрации
   в своей версии форка: одного файла Helper недостаточно.
3. В `getVideoData()` получить канонический идентификатор и номер части,
   вызвать регистрацию на UMP (если сайт использует этот маршрут), проверить
   ответ `mediaUrl` и вернуть URL **UMP-медиа**, а не CDN-адрес или страницу.
4. Реализовать соответствующий серверный endpoint регистрации, если Helper
   его вызывает. В примере Bilibili это `POST /api/bilibili/register` с
   `{ bvid, page }`, ответ `{ mediaUrl }`; постоянный путь:
   `/media/bilibili/<BVID>/p<PAGE>/audio.m4a`.
5. Проверить, какой метод базового `VOTClient` вызывается для такого URL.
   В проверенном `@vot.js/core` `isCustomLink()` распознаёт `.m4a`, `.mpd`,
   `.m3u8` и ведёт в `translateVideoVOTImpl()` -> `requestVOT()` (JSON),
   **минуя** `VOTProtobufEnvelopeClient.request()`. Сервер UMP тогда пишет
   `[MEDIA MODE] Unsupported media request Content-Type: application/json`.
6. Для Bilibili исправление — переопределить `isCustomLink()` **в клиентском**
   `src/videoHandler/modules/protobufEnvelopeProvider.ts` так, как показано в
   [`docs/reference/protobufEnvelopeProvider.ts`](../docs/reference/protobufEnvelopeProvider.ts).
   Возвращать `false` только для подтверждённого URL Bilibili на доверенном
   UMP-хосте, а остальные URL передавать `super.isCustomLink(url)`.
   Для **нового сайта** добавляйте отдельное узкое правило только после
   проверки его маршрута, типа URL и протокола подписи.
7. Убедиться, что для этого сайта реально создан `VOTProtobufEnvelopeClient`
   и запрос проходит `request()` -> Protobuf Envelope с заголовком
   `application/x-vot-envelope+protobuf`. Выбор клиента проверять в
   `initVOTClient()` (или аналоге текущей версии VOT), не меняя глобально
   маршрутизацию Douyin и прямой `api.browser.yandex.ru`.
8. Проверить на практике регистрацию, HTTP Range, отправку перевода,
   звук/субтитры и отсутствие регрессий на существующих сайтах.

**Важно о подписанном запросе:** `sourceVideoUrl` внутри Envelope —
метаданные, а не замена URL в подписанном бинарном теле. Серверный адаптер
Bilibili принимает подписанный UMP URL и пересылает тело без переписывания.
Не пытайтесь «исправлять» JSON-запрос добавлением только `Content-Type`:
нужно выбрать правильную ветку клиента и передать настоящее бинарное тело.

**Ограничение примера:** `bilibili-helper-user-example.js` взят из конкретного
форка VOT и содержит жёстко заданный UMP-хост. При переносе в другую версию
проверьте API `BaseHelper`, механизм регистрации Helpers, разрешения GM XHR
и актуальную конфигурацию прокси. Это образец, а не универсальный модуль.

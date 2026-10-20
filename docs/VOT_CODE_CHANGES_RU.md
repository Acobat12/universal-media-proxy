# Изменения VOT для Universal Media Proxy — проверено по voice-over-translation-master

> Это **инструкция по внесению изменений в существующий код**, а не предложение заменить файлы. Конкретный пример изменений для загруженного `voice-over-translation-master(11).zip` дан в [`VOT_REFERENCE_CHANGES.patch`](VOT_REFERENCE_CHANGES.patch). В другой версии ищите соответствующие функции, а не копируйте файлы целиком.

## Важный вывод по совместимости

**Для текущего сервера выбирайте режим 3 (Protobuf Envelope).** Обычный `VOTNextWorkerProvider` в режиме 2 не гарантирует совместимость с серверным обработчиком: сервер ожидает `application/x-vot-envelope+protobuf` либо отдельную двухшаговую передачу метаданных. Одного перенаправления адреса недостаточно.

**Авторизация пока не согласована:** установщик задаёт `VOT_PROXY_API_KEY`, сервер требует заголовок `X-Proxy-Key`, а приведённый клиентский провайдер его не отправляет. Следовательно, при стандартной установке перевод через этот клиент вернёт **401**. Не публикуйте ключ в общедоступном userscript/расширении. Для реального развёртывания нужен отдельный безопасный способ аутентификации, например доступ к прокси через приватную сеть или серверный шлюз с проверкой пользователя. Для *временного локального теста* можно очистить `VOT_PROXY_API_KEY` в конфигурации и перезапустить сервис, но открывать такой прокси в интернет нельзя.

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

В проверенной структуре новый модуль: `src/videoHandler/modules/protobufEnvelopeProvider.ts`. **Полный код** находится в `VOT_REFERENCE_CHANGES.patch` (блок добавления нового файла). В нём должны быть:

- `varint`, `field`, `concat` для бинарного кодирования;
- `encodeVotEnvelope(headers, body, path)` — поле 1: map заголовков, поле 2: тело, поле 3: внутренний путь;
- `VOTProtobufEnvelopeProvider extends VOTNextWorkerProvider`, переопределяющий `request()`;
- HTTP-заголовок `Content-Type: application/x-vot-envelope+protobuf`.

**Нельзя** просто выставить Content-Type и отправить исходный body: сервер попытается разобрать Protobuf и вернёт ошибку.

Внутри Envelope путь должен быть `/video-translation/translate` (без `/vot`), а внешний URL — `https://YOUR_DOMAIN/vot/video-translation/translate`. Обязательно проверить сигнатуры `getOpts`, `fetch`, `schema`, `host` установленного `@vot.js/core` — клиентская сборка здесь не запускалась.

## 4. Подключите провайдер при создании VOT-клиента

В проверенном VOT: `src/VideoHandler.ts`, метод `buildVOTClient()`. Импортируйте новый класс и замените выбор `provider`:

```ts
provider: this.data?.translateProxyEnabled === 3
  ? VOTProtobufEnvelopeProvider
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
4. Если ответ **401**, проблема в `X-Proxy-Key`, а не в Protobuf.
5. Если ответ **400**, проверьте бинарное тело, внутренний путь и заголовки.
6. Если **404**, проверьте `/vot` и маршруты.
7. Отдельно проверьте аудио и субтитры. Успешные тесты сервера не подтверждают реальный перевод Яндекса.

## Что ещё НЕ подтверждено

Патч составлен по загруженным исходникам, но клиент **не собран** и не проверен с реальным API Яндекса. Полная поддержка произвольных версий VOT не гарантируется. Авторизация клиента и сервера требует отдельного безопасного решения до публичного развёртывания.

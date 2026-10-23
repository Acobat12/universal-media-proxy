> **Обновление публичной версии:** сервер VOT больше не требует `VOT_PROXY_API_KEY` или `X-Proxy-Key`. Упоминания проверки ключа ниже относятся к прежней защищённой версии.

# Замена существующего прокси VOT на Universal Media Proxy — проверка исходников

**Проверенные архивы:** `src (9)(9).zip` (исходники браузерного VOT) и `universal-media-proxy-vot-protobuf-detailed(2).zip` (сервер). Это инструкция **замены существующего транспорта**, а не добавления четвёртого пункта меню. Код ниже относится именно к структуре первого архива.

## Вывод

**Рекомендуемый вариант:** оставить пользовательские режимы `0 / 1 / 2` и заменить транспорт `VOTWorkerClient` на собственный `VOTProtobufEnvelopeClient` для режимов `1` и `2`. Так не требуется менять интерфейс и тип `TranslateProxyStatus`, а сервер получает корректный одношаговый Protobuf Envelope. При этом старый встроенный прокси `vot-worker.kload.workers.dev` нужно заменить на адрес **вашего развёрнутого сервера** (это изменение влияет на всех пользователей режима `1`).

**Важное ограничение:** в архиве `src` нет исходников зависимости `@vot.js/ext`, поэтому нельзя считать, что существующий `VOTWorkerClient` совместим с сервером. Сервер в архиве требует `application/x-vot-envelope+protobuf` или двухшаговую передачу метаданных; просто изменить домен недостаточно.

## Подтверждённые места изменений

| Файл | Что обнаружено | Что сделать |
|---|---|---|
| `src/client.ts` | Локальный `VOTClient` уже переопределяет `request()` и `createSession()` | Новый клиент должен **наследовать локальный `VOTClient`**, чтобы сохранить подпись сессии и обработку ошибок |
| `src/videoHandler/modules/protobufEnvelopeProvider.ts` | Файла нет | **Создать обязательно** для рекомендуемого режима Envelope; код ниже |
| `src/index.ts`, `initVOTClient()` (строки ~1025–1059) | Выбор между `VOTClient` и `VOTWorkerClient`, `host` — строка без протокола | Импортировать новый класс и заменить выбор клиента |
| `src/config/config.ts` (~13) | `proxyWorkerHost = "vot-worker.kload.workers.dev"` | Для замены встроенного прокси указать свой домен **с `/vot`**, без `https://` (см. ограничения ниже) |
| `src/videoHandler/modules/proxyShared.ts` | Переписывает аудио/субтитры только при режиме `2`; конструирует `https://${host}`; обратное преобразование не знает о `/vot` | Исправить сборку и обратное преобразование URL; для полного проксирования режима `1` расширить проверку |
| `src/ui/views/settings.ts` (~913–959, ~1655–1684) | Три существующих режима `0,1,2` и текстовое поле адреса | Меню не расширять; изменить описание режимов/placeholder при необходимости |
| `src/types/storage.ts` (~67) | `TranslateProxyStatus = 0 | 1 | 2` | **Не менять** при замене существующего прокси |
| `src/videoHandler/modules/translation.ts` (~1402–1425) | При смене прокси уже очищается кэш, останавливается перевод и пересоздаётся клиент | Сохранить как есть |
| `src/videoHandler/modules/subtitles.ts` (~516–525) | Использует `proxifyYandexSubtitlesUrl()` | Исправления в `proxyShared.ts` автоматически применятся |
| `src/videoHandler/modules/init.ts` (~128–142) | Автоматически назначает режимы `1` и `2` | Учитывать, что оба режима после замены будут использовать новый сервер |

## Сервер: фактические маршруты и формат

`src/server.js` направляет внешние `/vot/*` в `src/vot-gateway.js`. Шлюз **удаляет префикс `/vot`** перед вызовом `src/vot-worker.js`.

| Снаружи | Внутри Worker и в поле Envelope `path` |
|---|---|
| `/vot/session/create` | `/session/create` |
| `/vot/video-translation/translate` | `/video-translation/translate` |
| `/vot/video-subtitles/get-subtitles` | `/video-subtitles/get-subtitles` |
| `/vot/video-translation/audio-proxy/FILE.mp3?...` | `/video-translation/audio-proxy/FILE.mp3?...` |
| `/vot/video-subtitles/subtitles-proxy/FILE?...` | `/video-subtitles/subtitles-proxy/FILE?...` |

**Не помещать `/vot` в поле Envelope `path`**: сервер сверяет его с внутренним путём и вернёт `Envelope path mismatch`.

**Обнаруженный дефект сервера:** `src/vot-gateway.js` разрешает `'/vot/metadata'` в `allowedPaths`, но перед проверкой уже удаляет `/vot`. Поэтому внешняя точка `/vot/metadata` сейчас возвращает `404`. Для рекомендуемого одношагового Envelope она **не нужна**. Если потребуется двухшаговый транспорт, исправить шлюз отдельно и добавить тесты. Не смешивать два способа передачи.

## Шаг 1. Создать `src/videoHandler/modules/protobufEnvelopeProvider.ts`

Это **новый файл в существующем `src/videoHandler/modules/`**. Здесь не используется импорт `VOTNextWorkerProvider` из другой версии `@vot.js/core`: у проверенного форка есть свой локальный `VOTClient`.

```ts
import VOTClient from "../../client";

const encoder = new TextEncoder();
const ALLOWED = /^(?:sec-vtrans-[a-z0-9-]+|sec-vsubs-[a-z0-9-]+|vtrans-[a-z0-9-]+|vsubs-[a-z0-9-]+|sec-ch-ua(?:-[a-z0-9-]+)?|accept-language|authorization|pragma|cache-control)$/;

function varint(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid length");
  const out: number[] = [];
  do { const b = n % 128; n = Math.floor(n / 128); out.push(n ? b | 128 : b); } while (n);
  return out;
}
function field(tag: number, bytes: Uint8Array): Uint8Array {
  const len = varint(bytes.byteLength);
  return Uint8Array.from([tag, ...len, ...bytes]);
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
export function encodeVotEnvelope(
  headers: Record<string, string>, body: Uint8Array, path: string,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED.test(name) || typeof value !== "string" ||
        value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) continue;
    parts.push(field(10, join([
      field(10, encoder.encode(name)),
      field(18, encoder.encode(value)),
    ])));
  }
  parts.push(field(18, body));
  parts.push(field(26, encoder.encode(path)));
  return join(parts);
}

/** Request path stays INTERNAL (no /vot); this.host contains external /vot. */
export default class VOTProtobufEnvelopeClient extends VOTClient {
  override async request<T = ArrayBuffer>(
    path: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
    method = "POST",
  ) {
    // Local VOTClient handles session signing, error responses, and aborts.
    // Its request() cannot be called here because it sends the raw body.
    // Encode the original metadata in the Envelope, then let the parent
    // request() send it with the envelope content type.
    const envelope = encodeVotEnvelope(headers, body, path);
    return super.request<T>(path, envelope, {
      "Content-Type": "application/x-vot-envelope+protobuf",
    }, method);
  }
}
```

**Внимание: этот компактный вариант — отправная точка, а не доказанная сборка.** Проверить, не добавляет ли `getOpts()` в `src/client.ts` или `@vot.js/ext` другие заголовки, которые перезаписывают `Content-Type`. Также проверить, что `getOpts()` корректно отправляет `Blob` с `Uint8Array` через `GM_fetch` и что сервер действительно получает бинарные байты. На практике `getOpts()` может добавлять служебные заголовки; если серверу нужны некоторые из них как **внутренние** заголовки Яндекса, их необходимо включать в Envelope до сериализации, а не только в HTTP-заголовки к прокси.

### Критически важная проверка подписи и заголовков

В `src/client.ts` метод `createSession()` передаёт `Vtrans-Signature` в `request()`. Приведённый код переносит его в Envelope. Но остальные запросы могут генерировать дополнительные заголовки в `getOpts()` зависимости. **Перед выпуском сравнить реальные заголовки исходных запросов с теми, которые попадут в Envelope**, иначе перевод может не работать, даже если сессия создаётся.

## Шаг 2. Изменить `src/index.ts`

Добавить импорт рядом с `import VOTClient, { VOTWorkerClient } from "./client";`:

```ts
import VOTProtobufEnvelopeClient from "./videoHandler/modules/protobufEnvelopeProvider";
```

В `initVOTClient()` заменить вычисление `transportHost` и создание клиента на следующую схему:

```ts
const proxyMode = this.data?.translateProxyEnabled ?? 0;
const proxyHost = (this.data?.proxyWorkerHost || proxyWorkerHost)
  .trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
// Внешняя база должна иметь ровно один /vot.
const transportHost = proxyMode === 0
  ? workerHost
  : proxyHost.endsWith("/vot") ? proxyHost : `${proxyHost}/vot`;

this.votOpts = {
  fetchFn: GM_fetch,
  fetchOpts: {
    signal: this.actionsAbortController.signal,
    forceGmXhr: true,
  },
  apiToken: this.data?.account?.token,
  hostVOT: votBackendUrl,
  host: transportHost,
};
this.votClient = proxyMode === 0
  ? new VOTClient(this.votOpts)
  : new VOTProtobufEnvelopeClient(this.votOpts);
```

**Остальную часть `initVOTClient()` не удалять**: там восстанавливаются сессии и переопределяется `getSession()` для сохранения в кэше. Уточнить тип `votClient` в `src/index.ts`, если TypeScript потребует; новый класс наследует `VOTClient`, поэтому исходный тип `VOTClient | VOTWorkerClient` уже включает его структурно.

**Ограничение:** схема рассчитана на домен без пользовательского префикса пути либо на домен с `/vot`. Для нестандартного префикса требуется отдельный URL-builder. Значение `https://.../vot` преобразуется в `host = ".../vot"`, потому что `src/client.ts` строит URL как `${this.schema}://${this.host}${path}`.

## Шаг 3. Заменить встроенный прокси

В `src/config/config.ts` заменить:

```ts
export const proxyWorkerHost = "vot-worker.kload.workers.dev";
```

на:

```ts
export const proxyWorkerHost = "YOUR_PROXY_DOMAIN.example";
```

`/vot` добавляет код из шага 2. **Это должен быть реально развёрнутый адрес**, а не пример. В режиме `2` пользователь может указать собственный домен в настройках.

**Не менять** `workerHost = "api.browser.yandex.ru"`: это прямой режим `0`.

## Шаг 4. Исправить `src/videoHandler/modules/proxyShared.ts`

Сейчас аудио и субтитры переписываются только в режиме `2`, а `unproxifyYandexAudioUrl()` не узнаёт путь `/vot/video-translation/audio-proxy/...`. Если режим `1` тоже должен полностью проксировать медиа, используйте для него те же правила.

**Рекомендуемая замена всего содержимого файла** (с сохранением экспортируемых имён):

```ts
import { proxyWorkerHost } from "../../config/config";
const AUDIO_SOURCE = "https://vtrans.s3-private.mds.yandex.net/tts/prod/";
const SUB_SOURCE = "https://brosubs.s3-private.mds.yandex.net/vtrans/";
const AUDIO_PATH = "/video-translation/audio-proxy/";
const SUB_PATH = "/video-subtitles/subtitles-proxy/";
type ProxyConfig = { translateProxyEnabled?: number | null; proxyWorkerHost?: string | null };

function base(config: { proxyWorkerHost?: string | null }): string {
  const raw = (config.proxyWorkerHost || proxyWorkerHost).trim();
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(normalized);
  if (u.protocol !== "https:") throw new Error("HTTPS proxy required");
  const path = u.pathname.replace(/\/+$/, "");
  u.pathname = path.endsWith("/vot") ? path : `${path}/vot`;
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}
function enabled(config: ProxyConfig): boolean {
  return config.translateProxyEnabled === 1 || config.translateProxyEnabled === 2;
}
function convert(source: string, prefix: string, route: string, config: ProxyConfig): string {
  if (!enabled(config) || !source.startsWith(prefix)) return source;
  return `${base(config)}${route}${source.slice(prefix.length)}`;
}
export function proxifyYandexAudioUrl(url: string, config: ProxyConfig): string {
  return convert(url, AUDIO_SOURCE, AUDIO_PATH, config);
}
export function proxifyYandexSubtitlesUrl(url: string, config: ProxyConfig): string {
  return convert(url, SUB_SOURCE, SUB_PATH, config);
}
export function unproxifyYandexAudioUrl(url: string): string {
  try {
    const u = new URL(url);
    const marker = `/vot${AUDIO_PATH}`;
    const idx = u.pathname.indexOf(marker);
    if (u.protocol !== "https:" || idx < 0) return url;
    return `${AUDIO_SOURCE}${u.pathname.slice(idx + marker.length)}${u.search}`;
  } catch { return url; }
}
export function isYandexAudioUrlOrProxy(
  url: string, config: { proxyWorkerHost?: string | null },
): boolean {
  return url.startsWith(AUDIO_SOURCE) ||
    url.startsWith(`${base(config)}${AUDIO_PATH}`);
}
```

**Примечание по безопасности:** для production лучше ограничить `unproxifyYandexAudioUrl()` только **своим настроенным прокси-доменом**. Показанный вариант определяет URL по пути, что функционально совместимо с текущими вызовами, но может ошибочно распознать чужой домен с таким же путём. Для строгого варианта потребуется передавать конфигурацию и в `unproxifyYandexAudioUrl()` из `src/videoHandler/modules/translation.ts`.

**Дополнительная проверка:** сервер требует у аудио окончание `.mp3` и непустую query string; некоторые ссылки Яндекса могут не соответствовать этим требованиям. Тогда проксирование такого URL завершится ошибкой — проверьте на реальных ответах API.

## Шаг 5. Исправить серверный шлюз, если нужен `/vot/metadata`

Для рекомендуемого Envelope этот маршрут не используется. Если планируется двухшаговый транспорт, в `src/vot-gateway.js` заменить:

```js
const path = incoming.pathname.slice('/vot'.length) || '/';
```

на:

```js
const path = incoming.pathname === '/vot/metadata'
  ? '/vot/metadata'
  : incoming.pathname.slice('/vot'.length) || '/';
```

И убедиться, что `allowedPaths` включает именно внутренний путь `'/vot/metadata'`. Добавить тест POST `/vot/metadata`, проверяющий, что запрос больше не получает `404`. **Не выполнять это изменение только ради Envelope.**

## Шаг 6. Авторизация и развёртывание

В `src/server.js` прокси активируется только при `ENABLE_VOT_PROXY=true`. Если задан `VOT_PROXY_API_KEY`, шлюз требует `X-Proxy-Key`. В приведённом браузерном клиенте такой заголовок **не передаётся**. Для публичного VOT нельзя вшивать общий секрет в userscript — его сможет прочитать любой пользователь. Использовать собственную клиентскую авторизацию/шлюз или осознанно оставить VOT gateway без статического ключа, обеспечив защиту на внешнем уровне.

Проверить, что `@connect` userscript / `host_permissions` расширения допускают новый домен. В архиве присутствует `src/headers.json`, но итоговый userscript metadata и extension manifest могут собираться из файлов **за пределами `src`**. Не объявлять проверку завершённой без корня репозитория.

## Шаг 7. Проверки перед релизом

1. `0`: запросы напрямую к `https://api.browser.yandex.ru/session/create` и `.../video-translation/translate`.
2. `1`: запросы к `https://YOUR_PROXY_DOMAIN.example/vot/...` в формате Envelope; аудио и субтитры тоже через прокси, если это задумано.
3. `2`: собственный домен пользователя, ровно один `/vot`.
4. Внутри Envelope `path` **без `/vot`**. Проверить отсутствие `Envelope path mismatch`.
5. Убедиться, что `Vtrans-Signature` и остальные требуемые заголовки Яндекса реально находятся в Envelope.
6. Убедиться, что `Content-Type` запроса к прокси — `application/x-vot-envelope+protobuf`, тело — бинарный Envelope, а не JSON/обычный Protobuf.
7. Проверить `session/create`, `video-translation/translate`, получение аудио, субтитры, смену настроек, повторный перевод и восстановление сессий.
8. Проверить сетевые ошибки, `401`, `404`, CORS/`@connect`, `413` и отсутствие скрытого fallback.
9. Выполнить `npm test` в серверном проекте, затем TypeScript-проверку/сборку **полного** репозитория VOT. В предоставленном `src` нет полного проекта и `package.json`.

## Альтернатива: оставить старый прокси и добавить новый режим

Если важно не ломать пользователей встроенного `vot-worker.kload.workers.dev`, безопаснее добавить отдельный режим `3` и оставить режимы `0/1/2` без изменений. Тогда расширить `TranslateProxyStatus` до `0 | 1 | 2 | 3`, добавить пункт в `src/ui/views/settings.ts`, а новый клиент выбирать **только для режима `3`**. Это больше изменений, зато сохраняет обратную совместимость. Для тестирования перед массовой заменой этот вариант предпочтительнее.

## Что подтверждено, а что нет

Подтверждены пути файлов, текущий выбор клиента, схема маршрутизации `/vot`, формат Envelope, ошибочный маршрут metadata и места обработки медиа. **Не подтверждены** TypeScript-сборка, поведение `getOpts()` из внешней библиотеки, полный набор необходимых заголовков в Envelope, корректность `GM_fetch` на конкретных браузерах, авторизация развёрнутого сервера и работа реального перевода. Поэтому внедрение следует считать техническим планом с конкретным кодом, а не уже проверенным готовым патчем.

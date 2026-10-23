# Проверка интеграции VOT

- [ ] `BilibiliHelper` зарегистрирован в VOT и возвращает URL UMP после `/api/bilibili/register`.
- [ ] `initVOTClient()` создаёт `VOTProtobufEnvelopeClient` для Bilibili.
- [ ] `protobufEnvelopeProvider.ts` содержит ограниченное исключение `isCustomLink()` для Bilibili `.m4a`.
- [ ] Запрос перевода отправляется как `application/x-vot-envelope+protobuf`.
- [ ] Медиа отдаётся с HTTP Range (206); перевод и звук работают.
- [ ] Douyin и прямой API Яндекса работают как раньше.
- [ ] Для нового сайта Helper зарегистрирован, серверный адаптер подключён и проверен путь `translateVideo()`.

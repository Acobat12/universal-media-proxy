# Чек-лист интеграции VOT

Отмечайте пункты по мере настройки **своего** форка VOT.

- [ ] На VPS работает HTTPS и `GET /health`.
- [ ] В окружении сервера задан `ENABLE_VOT_PROXY=true`.
- [ ] В тип `TranslateProxyStatus` добавлено значение `3`.
- [ ] В UI VOT появился режим «Свой сервер (protobuf)».
- [ ] Подключён `VOTProtobufEnvelopeClient`; исправлен импорт `VOTClient`.
- [ ] `buildVOTClient()` выбирает новый провайдер для режима `3`.
- [ ] Путь внутри protobuf не содержит `/vot`, а внешний URL содержит ровно один `/vot`.
- [ ] Аудио и субтитры также проксируются в режиме `3`.
- [ ] Добавлены разрешения `@connect` или `host_permissions` для своего домена.
- [ ] VOT собирается без ошибок типов.
- [ ] В DevTools виден POST с `application/x-vot-envelope+protobuf`.
- [ ] Проверены реальный перевод, звук, субтитры и несколько сайтов.
- [ ] Настроены HTTPS, лимиты нагрузки и защита публичного прокси.

Подробная последовательность: [VOT_QUICKSTART_RU.md](VOT_QUICKSTART_RU.md). Изменения для ранее проверенного форка: [VOT_CODE_CHANGES_RU.md](VOT_CODE_CHANGES_RU.md).

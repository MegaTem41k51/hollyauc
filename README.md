🎄 HollyAuc — поинтовые аукционы для стримеров
Реальный сайт: вход через Twitch, интеграция DonationAlerts (донаты зачисляются в аукцион автоматически), живые обновления через SSE, колесо удачи.
Запуск
```bash
node server.js        # нужен только Node.js 18+, зависимостей нет
```
Откроется на http://localhost:3000
Настройка (обязательно, иначе вход не заработает)
Скопируй `.env.example` → `.env` и заполни:
1. Twitch (вход на сайт)
Зайди на https://dev.twitch.tv/console → Register Your Application
Name: `HollyAuc`, OAuth Redirect URL: `http://localhost:3000/auth/twitch/callback`
Category: Website Integration → получишь Client ID и Secret → в `.env`
2. DonationAlerts (автозачёт донатов)
Зайди на https://www.donationalerts.com/application → создай приложение
Redirect URL: `http://localhost:3000/auth/da/callback`
Client ID и Secret → в `.env`
Как это работает
Стример входит через Twitch → нажимает «Подключить DonationAlerts»
Создаёт аукцион: название, шаг ставки, лоты → получает ссылку `/a/xxxxxx`
Отдаёт ссылку чату. Зрители ставят баллы прямо на сайте (ник не обязателен)
Донаты зачисляются сами: сервер раз в 6 секунд проверяет новые донаты через API DonationAlerts:
в сообщении есть `#3` → баллы уходят в лот 3
нет `#` → баллы уходят в текущий лидирующий лот
курс: `POINTS_PER_RUB` баллов за 1 ₽ (по умолчанию 100)
Стример жмёт «Крутить колесо» — побеждает лот с шансом пропорционально ставкам
Данные
Всё хранится в `data.json` (создастся сам). Сессии — в куках, паролей нет.
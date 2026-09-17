# JARVIS Local Codex

Локальный Windows-ассистент с браузерным интерфейсом, голосовым вводом и подключением к текущему сеансу Codex через Codex App Server. Проект хранит runtime-данные рядом с приложением и не требует `OPENAI_API_KEY`.

## Возможности

- Диалог с локальным Codex App Server, потоковые ответы и управление тредами.
- Окно подтверждения для действий, которые App Server требует подтвердить.
- Windows host: push-to-talk по правому `Ctrl`, локальная транскрипция через faster-whisper и компактный overlay-ответ.
- Parser для поиска и мониторинга Telegram-групп с локальным Python worker; ответы пользователям автоматически не отправляются.
- Crypto workspace: сканирование публичного Binance USD-M Futures, локальные preview-графики и отдельный режим публикации в Binance Square.

## Как это устроено

```text
Browser UI ──> Node.js server ──> Codex App Server
                      │
Windows voice host ───┼──> faster-whisper worker (local)
                      │
Telegram Parser ──────└──> Python / Telethon worker (local)
```

Node.js сервер раздаёт локальный интерфейс и координирует интеграции. Windows host передаёт короткую аудиозапись в локальный сервис транскрипции; временный аудиофайл удаляется после обработки. Parser сохраняет настройки и состояние локально. Crypto-модуль использует публичные рыночные endpoints; в режиме `AUTO` для Binance Square нужен отдельный credential.

## Стек

- Node.js (ES modules; Node.js 22+)
- Windows Forms / .NET Framework C# host
- Python 3.12, faster-whisper
- Python Telethon 1.44 для Parser
- Codex CLI / Codex App Server

## Структура

```text
public/          browser interface
src/             Node.js server, voice, crypto and parser bridge
windows-host/    Windows push-to-talk host
speech/          faster-whisper worker
parser_worker/   local Telethon parser worker
scripts/         setup and Windows-host build scripts
test/            Node.js test suite
```

## Требования

- Windows
- Node.js 22 или новее
- Codex CLI с доступным App Server
- Python 3.12 (`py -3.12`) для голосового режима и Parser
- .NET Framework C# compiler, поставляемый с Windows .NET Framework

Модель faster-whisper не входит в репозиторий: она скачивается локально при первом распознавании.

## Установка и запуск

1. Клонируйте репозиторий и откройте его корневую папку.
2. Убедитесь, что `node`, `codex` и `py -3.12` доступны в `PATH`.
3. Запустите `START_JARVIS.bat`.

Скрипт подготавливает локальные Python-зависимости, собирает Windows host и запускает его. Интерфейс открывается на `http://127.0.0.1:3210`. Для остановки используйте `STOP_JARVIS.bat`.

## Конфигурация

`.env.example` — справочник переменных; приложение не загружает `.env` автоматически. Передавайте нужные значения через environment процесса или пользователя. Никогда не добавляйте реальные credentials в репозиторий.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JARVIS_PORT` | No | Local HTTP port (default `3210`) |
| `JARVIS_ASR_MODEL` | No | faster-whisper model name (default `small`) |
| `JARVIS_ASR_DEVICE` | No | Speech device (default `cpu`) |
| `JARVIS_ASR_COMPUTE_TYPE` | No | Speech compute type (default `int8`) |
| `JARVIS_CRYPTO_MODE` | No | `OFF`, `DRY_RUN`, or `AUTO`; default is `DRY_RUN` |
| `JARVIS_CRYPTO_WRITER_PROVIDER` | No | Crypto writer provider: `ollama` or `anymodel` |
| `ANYMODEL_API_KEY` | Only for configured AnyModel writer | API key supplied locally |
| `BINANCE_SQUARE_OPENAPI_KEY` | Only for Crypto `AUTO` | Binance Square publishing credential |

Other verified crypto tuning variables are documented in `.env.example`.

## Telegram Parser

Parser setup is performed from **Parser → Settings**. Telegram API ID/API hash, phone number, session material, optional OpenRouter credential and notification-bot values are kept in the local Parser data store using Windows DPAPI encryption. A Telethon session is created locally during login and is never part of the repository. Use a secondary Telegram account as intended by the application.

## Crypto workspace

The scanner consumes public Binance USD-M Futures data. `OFF` disables the Crypto workflow, `DRY_RUN` generates a local preview without publishing, and `AUTO` enables the separate Binance Square publishing path only after its runtime credential is configured. The project does not use trading or withdrawal keys.

## Tests and checks

Run the Node.js suite:

```powershell
npm.cmd test
```

Run Parser tests after the project-local Python environment is prepared:

```powershell
npm.cmd run test:parser
```

## Privacy and security

The repository intentionally excludes local runtime state: Parser databases, Telegram sessions, audio, transcripts, logs, model caches, generated previews and credentials. Review `.gitignore` before adding new runtime directories. Keep secrets in the local environment or the local encrypted store; do not pass credentials on the command line.

## Limitations

- Windows host and voice workflow are Windows-specific.
- Voice recognition depends on a locally available faster-whisper setup and model download.
- Codex functionality requires a working local Codex session / App Server.
- Telegram and Binance Square integrations require their own user-provided local configuration.

## License

No license selected; none added automatically.

# dsh-wordbook-config

A tiny local settings bridge for `dsh-wordbook`.

- `GET /dsh-wordbook-config/api/maimemo` — returns `{configured: true|false}` only.
- `POST /dsh-wordbook-config/api/maimemo` — accepts `{token}` and writes it to `$DSH_HOME/maimemo/config.json` with mode 600.

The saved token is **never returned to the browser**. It is read by `dsh-maimemo` on each request, so changing it takes effect without a restart.

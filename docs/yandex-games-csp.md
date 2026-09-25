# Yandex Games embedding and CSP

The `/yandex` shell and its `/yandex/**` online-room routes get a dedicated CSP. Ordinary Pocker routes keep `frame-ancestors 'none'` and do not allow the Yandex SDK script.

Set the server-only `YANDEX_GAMES_FRAME_ANCESTORS` to a space-separated list of exact HTTPS origins from the approved Yandex Games parent/launch origins. Do not include paths or wildcards. If unset or malformed, embedding fails closed (`frame-ancestors 'none'`). For local development only, exact loopback HTTP origins such as `http://localhost:3000` are accepted. Never use those in production. `NUXT_PUBLIC_APP_URL` must be the canonical HTTPS app URL in production; it is used to permit only the matching `wss://` origin for the online-room socket. API requests remain same-origin.

The Yandex policy allows the official custom-domain SDK at `https://sdk.games.s3.yandex.net` in `script-src`. Images remain self/data/blob only: Yandex profile photos are not fetched, and the shell shows an initial instead. `X-Frame-Options: DENY` remains on WEB routes and is omitted on Yandex routes; CSP `frame-ancestors` is authoritative there.

For the Yandex Games Console's external host list, add only hosts actually referenced by the built app and its configured public URL. Current source references:

- `sdk.games.s3.yandex.net` — official SDK script.
- `fonts.googleapis.com` — stylesheet imported by the app.
- `fonts.gstatic.com` — font files.
- The hostname from the active `NUXT_PUBLIC_APP_URL` — app API and its same-host WSS socket (confirm the production environment value before submission; the repository's production domain is `pocker.kiruhak11.ru`).

Console entries are hostnames without scheme, path, or port, and Yandex requires secure HTTPS/WSS access. Do not add a wildcard or speculative SDK connection hosts. The console may separately require approval for iframe mode; this code does not configure or submit anything to Yandex.

## Local iframe check

Run the app in development with `YANDEX_GAMES_FRAME_ANCESTORS=http://localhost:3000`, `NUXT_PUBLIC_APP_URL=http://localhost:3000`, and `NUXT_PUBLIC_YANDEX_GAMES_MOCK=guest`. Restart Nuxt, then open `/dev/yandex-iframe`. The `/yandex` frame should render; `/rooms` should be blocked. The harness returns 404 outside a development build and is not linked from the app. Without the configured ancestor, `/yandex` also fails closed. For the official SDK path, use mock mode `off`; mock mode intentionally bypasses external SDK loading and is only honored in development.

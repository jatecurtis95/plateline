# Plateline

Vehicle compliance tracking. One board for the operator, a login and a live
dashboard for every client, and an automatic message at each of the ten stages.

## How it fits together

    Browser  ──►  these files          hosted on Vercel (static)
                      │
                      ▼
              /functions/v1/plateline  Supabase Edge Function (the API)
                      │
                      ▼
                  Postgres             clients, vehicles, messages, send log

Supabase cannot serve the pages itself: it forces `content-type: text/plain`
on everything it returns, so a browser shows source instead of a page. The
pages therefore live on a normal static host and call the API across origins.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Operator board. Passcode sign-in, ten-stage pipeline shown as four phase columns, inbox, notification settings. |
| `my.html` | Client dashboard. Opened from a signed link, shows only that client's car. |
| `app.css` | Shared stylesheet. Light and dark, driven by CSS custom properties. |

## Auth

Bearer tokens, not cookies, so the pages and the API can sit on different
domains.

- **Operator** posts a passcode to `/api/login` and gets a signed token back.
  Only a SHA-256 hash of the passcode is stored.
- **Client** uses the random token from their link. `my.html?t=<token>` stores
  it and strips it from the address bar.

Both are sent as `Authorization: Bearer <token>`.

## Database

Every table has row level security on with no policies, and `anon` /
`authenticated` are revoked. The public API keys can read nothing directly.
All access goes through the edge function's service role.

## Notifications

Every stage change writes an SMS and an email into `notification_log`. They
only leave the building when a sending account is configured in the Supabase
project secrets:

| Secret | For |
| --- | --- |
| `RESEND_API_KEY`, `SEND_FROM_EMAIL` | Email |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS |

Without them, messages are logged with status `held` and the board says so.

## Client links

Built from `settings.site_url`, which the API learns from the `Origin` header
the first time the board is opened on a new address. Move the site and the
links follow.

## Deploying

The three files are static. Any host that serves real `text/html` works.
Currently Vercel, deployed from this folder.

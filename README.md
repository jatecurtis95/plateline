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
| `supabase/functions/plateline/` | The API. Auth, the board query, notifications, documents, payments. |
| `supabase/migrations/` | Schema changes, in order. Apply before deploying the function that needs them. |

## Auth

Bearer tokens, not cookies, so the pages and the API can sit on different
domains.

- **Operator** posts a username and password to `/api/login` and gets a signed
  token back. Passwords are stored as PBKDF2-SHA256, 210,000 iterations, with a
  per-user salt.
- **Client** uses the random token from their link. `my.html?t=<token>` stores
  it and strips it from the address bar.

Both are sent as `Authorization: Bearer <token>`.

Sign-in used to be a passcode on its own, with no username. That made the
passcode the only thing identifying a person, so it had to be unique across
everyone: two people who chose the same one became the same person, and the
stage history named whichever the scan reached first. Rows still carrying the
old SHA-256 hash keep working and are rewritten as PBKDF2 the next time that
person signs in.

Ten failed attempts on one username within fifteen minutes stops that username
for the rest of the window. If the attempts table cannot be reached the check
passes rather than fails, because locking the office out of its own board is
worse than letting a guesser have a few more tries.

## Payments

Clients pay by card from their own page. Stripe hosted Checkout, so card
details never touch these pages, the API or the database.

Amounts are held in cents, GST inclusive, because that is what an Australian
customer must be quoted. `gst_cents` is the GST *within* the total, not an
amount added on top — at 10%, the total divided by eleven. The client sees both.

Three things hold this together, and none of them is optional:

- The amount charged is read from the `invoices` row inside
  `/api/client/checkout`. The browser never sends a price.
- An invoice is marked paid by `/api/stripe/webhook` and nowhere else. Landing
  on the success URL proves nothing — anyone can visit it.
- That webhook verifies Stripe's signature over the raw request body before it
  believes a word of it, which is why it runs before the shared JSON parse.

The operator can also mark an invoice paid by hand, for money that arrives some
other way; the record says who did it rather than claiming Stripe saw it.

Whether a client can pay yet is a setting: as soon as an amount is set, or not
until the car reaches a nominated stage. An amount the client is not meant to
see is left out of the payload entirely rather than hidden by the markup.

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
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Card payments |

Without them, messages are logged with status `held` and the board says so.

## Client links

Built from `settings.site_url`, which the API learns from the `Origin` header
the first time the board is opened on a new address. Move the site and the
links follow.

## Deploying

The pages are static. Any host that serves real `text/html` works. Currently
Vercel, deployed from this folder on every merge to `main`.

The API is not. It is deployed separately:

    supabase db push                                # migrations first
    supabase functions deploy plateline             # then the function

**Order matters when the two change together.** Deploy the pages first, then
the function. A new page talking to the old API sends fields the old API
ignores and carries on working; an old page talking to a new API does not. Doing
it the other way round signs everyone out until the pages catch up.

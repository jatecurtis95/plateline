# Go-live TODO

The work standing between the board as it is today and a board that holds up at
twenty-five cars a month, with what each piece costs to run.

Item 4 is built. Items 6 and 7 — proper sign-in, and clients paying from the
portal — are new asks specced but not started. Everything else is parked until
Wasam wants to go live.

**Six of the seven items are waiting on the same thing: item zero.**

Written 26 August 2026, updated 27 August.

## Where it stands today

5 clients, 5 live cars, 0 archived, 31 stage events, 7 messages, 0 documents.
No photos have ever been uploaded, so nothing below has been felt yet.

## Item zero: the API source is not version controlled

This repo is the front end only. `boardState`, the stage endpoints and the
notification code live in the Supabase edge function `plateline`, and that
source exists nowhere but inside the Supabase project. Four of the five items
below are changes to it, and none of them can be started until it is reachable.

One of:

- Pull the function into this repo under `supabase/functions/plateline/` and
  deploy from here. Best answer — it puts the whole system under one history.
- Install the Supabase CLI and link the project, working against it directly.
- Use a Supabase connection in the tooling that has write access.

Until then the only item that can be built is number 4.

## The work, in order

### 1. Filter the board query to live cars

`/api/op/state` runs three queries that pull whole tables and then filter in
JavaScript:

    db.from("messages").select("*")
    db.from("stage_events").select("*")
    db.from("documents").select("*")

Only `vehicles` is filtered on `archived = false`. Rows belonging to archived
cars still ship — in every response, every thirty seconds, to every signed-in
operator. At 25 cars a month that is roughly 3,000 stage events and 2,400
messages in year one, all of it sent every time.

**Change:** add `.in("vehicle_id", liveIds)` to each of the three queries in
`boardState`.
**Where:** edge function.
**Effort:** about half an hour once the source is reachable.

This is first because it removes the payload growth and the risk in item 2 in
a single change.

### 2. Check the PostgREST row cap

PostgREST caps how many rows a response may contain. The project's setting
could not be read at database level; Supabase's common default is 1,000. If
that is the value here, `stage_events` crosses it in roughly four months and
the board simply starts missing history — no error, no warning, nothing in the
interface to suggest anything is wrong.

**Change:** read it in the Supabase dashboard under Settings → API → Max rows.
**Effort:** five minutes, and worth doing before anything else on this list.

### 3. Get finished cars off the board

Nothing ever archives itself. `archived` is set only by the delete endpoints —
the Remove button on a car ([app.js:556](app.js#L556)). A car that reaches
"Passed - ready" stays on the board forever, so the board grows by 25 a month
with no ceiling.

Two ways:

- An **Archive** button, separate from Remove. Remove reads as destructive,
  which is why nobody will press it on a car that has merely finished.
- **Auto-archive** after N days at the final stage.

**Recommendation:** the button first — front end plus one endpoint — and
auto-archive once there is a feel for how long a finished car should linger.

### 4. Downscale photos before upload — BUILT

The only item that lived in this repo, and so the only one that could be built
without the edge function. It is done.

`uploadDoc` used to send the original file straight to storage, capped at 25MB.
A current phone photo is about 4032px and 3MB. At twenty photos a car and 25
cars a month that is 1.5GB a month — 18GB in year one, against a 1GB free tier
that a real month of photos would exhaust in about three weeks.

Photos are now drawn to a canvas and re-exported at 1600px on the long edge,
JPEG quality 0.85, before upload. Year one goes from roughly 18GB to 3GB.

The original is uploaded untouched whenever the resize is not clearly a win:
non-images, images already under 1600px, anything the browser cannot decode
(HEIC outside Safari), and any resize that failed to save space. Verified in
Chromium across all seven of those cases.

**Still Wasam's call.** These photos are compliance evidence. 1600px is more
than enough to show a client their car; it may not be enough to prove a defect
months later. If it isn't, the two numbers to change are `PHOTO_MAX_EDGE` and
`PHOTO_QUALITY` at the top of the upload section in `app.js`. A middle path
exists — downscale what the client sees, keep the original as the document —
at the cost of storing both, and that one is not built.

### 5. Stage wording is already editable — there is just no screen

**The stages are data, not code.** Both pages render whatever the API sends:
the board reads `op_label`, the client page reads `client_label`, `blurb` and
`you_note`, and nothing about the ten stages is hardcoded in the front end.
`/api/op/stage/save` writes them. So wording can be changed at any time,
mid-job, without a deploy — the only thing missing is somewhere to type it.

Four separate pieces of wording exist per stage, which is more control than it
first appears:

| Field | Who reads it |
| --- | --- |
| `op_label` | The operator, on the board |
| `client_label` | The customer, as the step name in their tracker |
| `blurb` | The customer, under whichever step is happening now |
| `you_note` | The customer, as "What happens next" |

Three things to know before handing this to Wasam:

- **Renaming is retroactive on screen.** The name is looked up by stage at
  render time, so changing it changes how every car reads, finished ones
  included. A client who saw "At workshop" last week sees the new wording when
  they next open the page.
- **Messages already sent do not change.** Those are delivered texts and
  emails. After a rename the tracker and the message history can word the same
  step differently.
- **Renaming is safe; adding, deleting or reordering stages is a different
  question.** Cars point at a stage, so a rename keeps everything attached.
  What `/api/op/stage/save` does about structural changes could not be checked
  — the source is not in the repo. Confirm before offering those.

**Change:** a settings screen with four fields per stage. Front end only, and
unblocked, since the endpoint already exists.

**Separately:** the four column headings — Approval, Workshop, Inspection,
Registration — *are* hardcoded, at `PHASE_NAMES` in `app.js`. Stage names are
editable; the four phases above them are not. If Wasam wants those reworded
too, that is a code change, or a new API field the front end should prefer.

## Asked for since

These are new features rather than scale problems, so they sit apart from the
list above. Both need the edge function, so both are behind item zero.

### 6. Username and password, instead of a passcode alone

Sign-in today posts `{ passcode }` and nothing else ([app.js:208](app.js#L208)).
There is no username field. The API works out who you are from *which* passcode
matched, which is where the name on the token comes from and how the `who` on
stage history gets filled in.

The sharp edge: **passcodes have to be unique across the whole team.** Two
people who pick the same one are the same person as far as the board is
concerned — whoever matches first wins, and the other signs in under their name,
on every stage move they make. Nothing warns anyone. There is also no username
for a password manager to key off, which pushes people toward short memorable
passcodes.

**The change:**

- A `username` column on the staff record, unique, and a username field on the
  sign-in form.
- `/api/login` verifies the pair rather than looking up by passcode.
- `/api/op/staff/save` takes and validates a username, rejecting duplicates.
- Existing people need a username backfilled before the old path is turned off.
  Derive one from the name, or have each person set theirs on next sign-in.

Signed tokens already issued keep working — they carry the identity, not the
passcode — so nobody is forced out mid-job by the change itself.

**Two things worth fixing while auth is open, neither of them cosmetic:**

- **The stored hash is plain SHA-256.** Unsalted SHA-256 is built to be fast,
  which is precisely wrong for a password: commodity hardware tries billions a
  second, and identical passcodes produce identical hashes, so a leaked table
  shows you who shares one. Moving to bcrypt or argon2id with a per-user salt is
  a small change while the login path is already being touched, and an awkward
  migration later.
- **No rate limiting was found on login.** Worth confirming in the function
  source — a passcode-only door with unlimited attempts is guessable in a way a
  username-and-password door is not.

### 7. Clients pay from the portal

**Decided:** Stripe hosted Checkout; the amount is set by the operator per car;
whether the client can pay is controlled by a setting, either as soon as an
amount is on the car or once the car reaches a nominated stage.

Hosted Checkout matters for a reason beyond convenience: card details never
touch Plateline or Supabase, which keeps the PCI burden near zero. Do not
replace it with a card form on the portal.

**Schema** — a new `invoices` table rather than columns on `vehicles`, so a car
can carry more than one charge later without a migration:

    id, vehicle_id, amount_cents, currency, status,
    stripe_session_id, stripe_payment_intent, created_at, paid_at

**Endpoints:**

| Endpoint | Does |
| --- | --- |
| `/api/op/invoice/save` | Operator sets or changes the amount on a car |
| `/api/client/checkout` | Creates a Checkout Session, returns the URL to redirect to |
| `/api/stripe/webhook` | Stripe calls this on payment; verifies signature, marks paid |

**Three rules that are not negotiable:**

- **The amount comes from the database, never from the client.** A price posted
  by the browser is a price the customer can edit.
- **Paid is set by the webhook, never by the return redirect.** A client landing
  back on the success URL proves nothing — they can visit it directly.
- **The webhook must verify the Stripe signature.** An unverified webhook
  endpoint is an open "mark this paid" button on the public internet.

**Client portal** (`my.js`): amount owing and a Pay button, subject to the
visibility setting, then a redirect out to Stripe and back. Paid cars show a
receipt line rather than a button.

**Operator board** (`app.js`): a payment chip on each car in the existing lists,
and a view listing who has paid and who has not, which is the part Wasam
actually asked for. The unpaid list is the useful one — sort it by how long the
amount has been sitting there.

**Secrets** — `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the Supabase
project, alongside the Resend and Twilio ones. Never in this repo.

**Still to decide:** whether GST needs to appear on what the client sees. If the
business is registered, the invoice should show it rather than burying it in a
single figure. That is an accounting question, not an engineering one.

## What it costs to run, at 25 cars a month

USD list prices, August 2026.

| | Per month | Why |
| --- | --- | --- |
| Supabase Pro | $25 | Needed once photos are real — the free tier holds 1GB. Pro includes 100GB, which covers year one either way. |
| Twilio SMS | ~$13 | 250 texts, ten a car. |
| Resend email | $0 | 250 emails sits inside the free tier. |
| Vercel | $0 | Static hosting. |
| **Total** | **~$38** | |

Stripe is not in that table because it is a percentage rather than a
subscription: roughly **1.75% + A$0.30** per domestic card, about 3.5% + A$0.30
international. It scales with what is charged, not with how many cars are on the
board, so it belongs in the price of the job rather than in running costs. On a
$1,500 compliance fee that is about $27 a car — larger than the entire hosting
bill, and worth Wasam seeing before it is switched on. Confirm the current rate;
this is list pricing and it moves.

Storage is the only figure that moves with the downscale decision: 18GB in
year one at full size, about 3GB resized. Both fit inside Pro, so item 4 buys
headroom rather than an immediate saving.

## Decisions needed before building

1. **Photo quality.** 1600px is now what gets stored. If compliance needs the
   full original, say so and it comes back out — two constants in `app.js`.
   A compliance question about what the photos have to prove, not an
   engineering one.
2. **How long a finished car stays on the board.** Needed to specify item 3.
3. **The wording of the ten stages.** Not needed to *build* item 5 — the screen
   can be built without knowing the words. Needed before Wasam gets any value
   from it.
4. **Whether GST shows on what the client sees.** Needed to finish item 7.
5. **Usernames for the people who already have passcodes.** Needed to migrate
   item 6 without locking anyone out.

Settled on 27 August 2026: Stripe hosted Checkout, the amount set per car by the
operator, and payment visibility as a setting — either as soon as an amount is
on the car, or once it reaches a nominated stage.

## Picking this up cold

- **Front end** — this repo. `app.js` is the operator board, `my.js` the client
  page, `app.css` is shared and drives both themes.
- **API and database** — Supabase edge function `plateline`. Not in version
  control. See item zero.
- **Hosting** — Vercel, static, deployed from this folder.
- **Live messaging** — off until `RESEND_API_KEY`, `SEND_FROM_EMAIL`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` are set in the
  Supabase project secrets. Until then every message logs with status `held`
  and the board says so.

## What is measured and what is not

**Measured**, by reading the Supabase project and edge function in an earlier
session: the row counts above, the three unfiltered queries, and the fact that
`archived` is only ever set by a delete.

**Estimated:** photo sizes and counts per car, the 1,000-row cap — the setting
could not be read, which is why item 2 exists — and every price here.

**Not verified against the source in this repo:** everything about the edge
function, because it is not here. Confirm each finding before building on it.

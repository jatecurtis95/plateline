-- Username sign-in, a real password hash, and client payments.
--
-- Safe to run more than once. Nothing here drops a column or deletes a row:
-- the old passcode hash is kept until each person next signs in, so a failed
-- deploy can be rolled back without locking anybody out of the board.

/* ------------------------------------------------------------- usernames */

alter table staff add column if not exists username text;

-- Backfill from the first name, lowercased, anything that is not a letter or
-- digit removed. Two people whose first names collide get a number, ordered
-- by id so the result is the same every time this runs.
with numbered as (
  select
    id,
    lower(regexp_replace(split_part(name, ' ', 1), '[^a-zA-Z0-9]', '', 'g')) as base,
    row_number() over (
      partition by lower(regexp_replace(split_part(name, ' ', 1), '[^a-zA-Z0-9]', '', 'g'))
      order by id
    ) as n
  from staff
  where username is null or username = ''
)
update staff s
set username = case when numbered.n = 1 then numbered.base
                    else numbered.base || numbered.n::text end
from numbered
where s.id = numbered.id and numbered.base <> '';

-- A name that produced nothing usable still needs something to sign in with.
update staff
set username = 'user' || left(replace(id::text, '-', ''), 8)
where username is null or username = '';

alter table staff alter column username set not null;

-- Usernames are always stored lowercase, so a plain unique index is enough
-- and lookups can use = rather than a pattern match.
create unique index if not exists staff_username_key on staff (username);

/* --------------------------------------------------------- password hash */

-- pbkdf2$<iterations>$<salt base64>$<hash hex>. The old passcode_sha256
-- column stays until each person signs in once, at which point the API
-- writes this column and clears that one.
alter table staff add column if not exists passcode_hash text;

/* ------------------------------------------------------- login throttling */

create table if not exists login_attempts (
  id bigserial primary key,
  key text not null,
  at timestamptz not null default now()
);

create index if not exists login_attempts_key_at on login_attempts (key, at desc);

alter table login_attempts enable row level security;
revoke all on login_attempts from anon, authenticated;

/* ---------------------------------------------------------------- money */

-- amount_cents is the total the customer pays, GST included, because that is
-- what an Australian customer is quoted and what Stripe is asked to charge.
-- gst_cents is the GST contained within it, not an amount added on top.
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  gst_cents integer not null default 0 check (gst_cents >= 0),
  currency text not null default 'aud',
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'void')),
  stripe_session_id text,
  stripe_payment_intent text,
  created_by text,
  paid_by text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists invoices_vehicle on invoices (vehicle_id);

-- A car may carry only one amount owing at a time. Paid and voided invoices
-- accumulate as the record of what happened.
create unique index if not exists invoices_one_unpaid
  on invoices (vehicle_id) where status = 'unpaid';

-- Same posture as every other table: the public keys can read nothing, and
-- all access goes through the edge function's service role.
alter table invoices enable row level security;
revoke all on invoices from anon, authenticated;

/* -------------------------------------------------------------- settings */

-- How the client portal decides whether to show an amount at all.
--   payment_visible_mode  = 'amount' (as soon as one is set) | 'stage'
--   payment_visible_stage = the stage id that opens it, when mode is 'stage'
insert into settings (key, value)
values ('payment_visible_mode', 'amount')
on conflict (key) do nothing;

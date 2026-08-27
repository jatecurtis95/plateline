// Plateline API.
//
// Rule this file is built on: nothing is readable that is not also writable.
// The first version showed a "waiting on" chip and an ETA the office had no
// way to enter, and recorded stage changes without recording who made them.
// Every field the board displays is settable here, and every change is
// attributed to the person who made it.
//
// Supabase serves text/plain, so it cannot host the pages. This is the API
// only; the pages are hosted separately and call in. Auth is a bearer token
// rather than a cookie so the two can live on different domains.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const te = new TextEncoder();

/* ---------------------------------------------------------------- plumbing */

function routeOf(req: Request) {
  let p = new URL(req.url).pathname;
  p = p.replace(/^\/functions\/v1/, "").replace(/^\/plateline/, "");
  return p === "" ? "/" : p;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const sha256hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));

function randToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A car sits on the board for this long after it is finished, then drops off.
const BOARD_KEEP_DAYS = 60;
// An explicit ceiling, so a query that outgrows it fails loudly in testing
// rather than quietly returning a short list in production.
const HARD_CAP = 5000;

// Passwords. SHA-256 is built to be fast, which is exactly what a password
// hash must not be, so a sign-in against the old column rewrites it as PBKDF2
// and clears the old one. Nobody is asked to change anything.
const PBKDF2_ITERATIONS = 210000;
// Generous, and it fails open below: locking the office out of its own board
// is a worse outcome than letting a guesser have a few more tries.
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 10;

// Money. amount_cents is GST-inclusive, so the GST inside a total is a
// division rather than a multiplication: at 10%, total / 11.
const GST_DIVISOR = 11;
// Stripe replays are rejected past this age, in seconds.
const STRIPE_TOLERANCE = 300;

const str = (v: unknown, max = 400) => String(v ?? "").trim().slice(0, max);
const nullable = (v: unknown, max = 400) => str(v, max) || null;

let _settings: Record<string, string> | null = null;
async function settings() {
  if (!_settings) {
    const { data } = await db.from("settings").select("key,value");
    _settings = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  }
  return _settings;
}

async function putSetting(key: string, value: string) {
  await db.from("settings").upsert({ key, value });
  (await settings())[key] = value;
}

async function hmacHex(msg: string) {
  const s = await settings();
  const key = await crypto.subtle.importKey(
    "raw", te.encode(s.cookie_secret ?? "unset"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
}

const mint = async (p: string) => p + "." + (await hmacHex(p));

async function unmint(tok: string | null) {
  if (!tok) return null;
  const i = tok.lastIndexOf(".");
  if (i < 1) return null;
  const p = tok.slice(0, i);
  return (await hmacHex(p)) === tok.slice(i + 1) ? p : null;
}

function bearer(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

// Returns the signed-in staff member, or null. The token carries the staff
// id; the name is read fresh each time so a rename shows up immediately and
// a deactivated account stops working without waiting for a token to expire.
async function staffOf(req: Request) {
  const p = await unmint(bearer(req));
  if (!p || !p.startsWith("op.")) return null;
  const { data } = await db.from("staff")
    .select("id,name,active").eq("id", p.slice(3)).maybeSingle();
  if (!data || !data.active) return null;
  db.from("staff").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return data as { id: string; name: string };
}

async function clientIdOf(req: Request) {
  const t = bearer(req);
  if (!t || t.includes(".")) return null;
  const { data } = await db.from("client_access").select("client_id").eq("token", t).maybeSingle();
  if (!data) return null;
  db.from("client_access").update({ last_used_at: new Date().toISOString() }).eq("token", t).then(() => {});
  return data.client_id as string;
}

const fill = (t: string, first: string, car: string, link: string) =>
  String(t ?? "").split("{name}").join(first).split("{car}").join(car).split("{link}").join(link);

const daysSince = (iso: string) =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString("en-AU", { day: "2-digit", month: "short", timeZone: "Australia/Perth" });

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Perth" });

/* ------------------------------------------------------------- passwords */

// Compares in time that does not depend on where the first difference is.
// A plain === leaks the length of the matching prefix to anyone timing it.
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pbkdf2Hex(pass: string, saltB64: string, iterations: number) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256,
  );
  return hex(bits);
}

async function hashPasscode(pass: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = btoa(String.fromCharCode(...salt));
  return "pbkdf2$" + PBKDF2_ITERATIONS + "$" + saltB64 + "$" +
    (await pbkdf2Hex(pass, saltB64, PBKDF2_ITERATIONS));
}

// Sixteen zero bytes. Only ever used to spend the same time on a username
// that does not exist as on one that does.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

// True if this passcode matches, by whichever scheme the row is stored in.
async function passcodeMatches(row: any, given: string) {
  if (row?.passcode_hash) {
    const [scheme, iter, salt, want] = String(row.passcode_hash).split("$");
    if (scheme !== "pbkdf2" || !salt || !want) return false;
    return sameSecret(await pbkdf2Hex(given, salt, Number(iter) || PBKDF2_ITERATIONS), want);
  }
  if (row?.passcode_sha256) return sameSecret(await sha256hex(given), String(row.passcode_sha256));
  // No such username, or a row carrying no password at all. Returning here
  // immediately would make an unknown username measurably faster than a known
  // one, which is a list of who works here. Do the work and throw it away.
  await pbkdf2Hex(given, DUMMY_SALT, PBKDF2_ITERATIONS);
  return false;
}

// Throttling. Every one of these swallows its error on purpose: if the
// attempts table is unreachable, sign-in carries on unthrottled rather than
// failing shut and taking the board down with it.
async function tooManyAttempts(key: string) {
  try {
    const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60000).toISOString();
    const { count } = await db.from("login_attempts")
      .select("id", { count: "exact", head: true }).eq("key", key).gte("at", since);
    return (count ?? 0) >= LOGIN_MAX_FAILURES;
  } catch {
    return false;
  }
}

async function noteFailure(key: string) {
  try { await db.from("login_attempts").insert({ key }); } catch { /* not worth failing a login over */ }
}

async function clearFailures(key: string) {
  try { await db.from("login_attempts").delete().eq("key", key); } catch { /* as above */ }
}

// The unique index does the enforcing; this only turns its message into one
// the person adding a colleague can act on.
const usernameTaken = (e: { message?: string }) =>
  /staff_username_key|duplicate key/i.test(e?.message ?? "")
    ? "Somebody already has that username."
    : (e?.message ?? "Could not save that sign-in.");

/* ------------------------------------------------------------------ money */

const money = (cents: number) => "$" + (Math.round(cents) / 100).toFixed(2);

// Dollars in, cents out. Anything that is not a positive number is zero, and
// the caller decides what to say about it.
function centsFrom(v: unknown) {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const gstWithin = (cents: number) => Math.round(cents / GST_DIVISOR);

// Whether the client is allowed to see an amount for this car yet. Either as
// soon as one is set, or not until the car reaches a nominated stage.
async function paymentVisible(vehicleStageId: string, stages: any[]) {
  const s = await settings();
  if ((s.payment_visible_mode ?? "amount") !== "stage") return true;
  const gate = stages.findIndex((x) => x.id === (s.payment_visible_stage ?? ""));
  if (gate < 0) return true;
  const at = stages.findIndex((x) => x.id === vehicleStageId);
  return at < 0 ? false : at >= gate;
}

const forClient = (inv: any) => inv && {
  id: inv.id,
  amount_cents: inv.amount_cents,
  gst_cents: inv.gst_cents,
  amount: money(inv.amount_cents),
  gst: money(inv.gst_cents),
  status: inv.status,
  paid_at: inv.paid_at ? dayMonth(inv.paid_at) : "",
};

/* ----------------------------------------------------------------- stripe */

// Stripe signs the exact bytes it sent. Anything that re-serialises the body
// before this runs will not verify.
async function stripeSigned(raw: string, header: string, secret: string) {
  const parts: Record<string, string> = {};
  for (const bit of header.split(",")) {
    const i = bit.indexOf("=");
    if (i > 0) parts[bit.slice(0, i).trim()] = bit.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > STRIPE_TOLERANCE) return false;
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const want = hex(await crypto.subtle.sign("HMAC", key, te.encode(t + "." + raw)));
  return sameSecret(want, String(parts.v1 ?? ""));
}

/* ----------------------------------------------------------- notifications */

async function deliver(channel: "sms" | "email", to: string, subject: string, body: string) {
  if (channel === "email") {
    const key = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("SEND_FROM_EMAIL");
    if (!key || !from) return { status: "held", detail: "No email account connected yet" };
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ from, to, subject, text: body }),
      });
      return r.ok ? { status: "sent", detail: "" } : { status: "failed", detail: (await r.text()).slice(0, 300) };
    } catch (e) {
      return { status: "failed", detail: String(e).slice(0, 300) };
    }
  }
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM");
  if (!sid || !tok || !from) return { status: "held", detail: "No SMS account connected yet" };
  try {
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(sid + ":" + tok),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    return r.ok ? { status: "sent", detail: "" } : { status: "failed", detail: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { status: "failed", detail: String(e).slice(0, 300) };
  }
}

async function rememberOrigin(req: Request) {
  const o = req.headers.get("origin");
  if (!o || !/^https?:\/\//.test(o) || o.includes("supabase.co")) return;
  const s = await settings();
  if (s.site_url !== o) await putSetting("site_url", o);
}

async function linkFor(cid: string) {
  const s = await settings();
  const base = (s.site_url ?? "").replace(/\/+$/, "");
  const { data } = await db.from("client_access").select("token").eq("client_id", cid).limit(1);
  let token = data?.[0]?.token;
  if (!token) {
    token = randToken();
    await db.from("client_access").insert({ token, client_id: cid });
  }
  return (base || "") + "/my.html?t=" + token;
}

// A stage change only reaches the client if the stage is switched on AND
// that client still wants that channel. Both switches are real: the stage
// one is the office's, the channel one is the client's.
async function notifyStage(vehicle: any, client: any, stageId: string) {
  if (!client) return { sent: false, held: false };
  const { data: tpl } = await db
    .from("notification_templates").select("*").eq("stage_id", stageId).maybeSingle();
  if (!tpl || !tpl.enabled) return { sent: false, held: false };

  const link = await linkFor(client.id);
  const smsBody = fill(tpl.sms_body, client.first_name, vehicle.description, link);
  const subject = fill(tpl.email_subject, client.first_name, vehicle.description, link);
  const mailBody = fill(tpl.email_body, client.first_name, vehicle.description, link) + "\n\n" + link;

  const rows: any[] = [];
  if (client.phone && client.notify_sms !== false) {
    const r = await deliver("sms", client.phone, "", smsBody);
    rows.push({ vehicle_id: vehicle.id, client_id: client.id, channel: "sms", recipient: client.phone,
      subject: null, body: smsBody, status: r.status, detail: r.detail,
      sent_at: r.status === "sent" ? new Date().toISOString() : null });
  }
  if (client.email && client.notify_email !== false) {
    const r = await deliver("email", client.email, subject, mailBody);
    rows.push({ vehicle_id: vehicle.id, client_id: client.id, channel: "email", recipient: client.email,
      subject, body: mailBody, status: r.status, detail: r.detail,
      sent_at: r.status === "sent" ? new Date().toISOString() : null });
  }
  if (rows.length) await db.from("notification_log").insert(rows);
  return { sent: rows.some((r) => r.status === "sent"), held: rows.some((r) => r.status === "held") };
}

/* ------------------------------------------------------------ board state */

// Reads one table for a set of cars. The ids go in the query string, so they
// are sent in batches - a few hundred UUIDs in one URL is past what PostgREST
// will accept, and that ceiling would arrive quietly.
const ID_BATCH = 100;

async function forCars(table: string, ids: string[], orderBy: string, asc: boolean) {
  if (!ids.length) return [] as any[];
  const batches: Promise<any>[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    batches.push(
      db.from(table).select("*")
        .in("vehicle_id", ids.slice(i, i + ID_BATCH))
        .order(orderBy, { ascending: asc })
        .limit(HARD_CAP),
    );
  }
  const parts = await Promise.all(batches);
  const rows = parts.flatMap((p: any) => p.data ?? []);
  // Batching loses the overall ordering, so restore it.
  rows.sort((a: any, b: any) => {
    const x = String(a[orderBy] ?? ""), y = String(b[orderBy] ?? "");
    return asc ? (x < y ? -1 : x > y ? 1 : 0) : (x > y ? -1 : x < y ? 1 : 0);
  });
  return rows;
}

async function boardState(me: { name: string }) {
  const { data: stageRows } = await db.from("stages").select("*").order("ord");
  const stages = stageRows ?? [];

  // Cars that finished more than sixty days ago come off the board. Nothing
  // is deleted and the customer keeps their record: this only sets the flag
  // the board filters on, and moving a car back to any earlier stage brings
  // it straight back.
  const last = stages[stages.length - 1];
  if (last) {
    const cutoff = new Date(Date.now() - BOARD_KEEP_DAYS * 86400000).toISOString();
    await db.from("vehicles").update({ archived: true })
      .eq("stage_id", last.id).eq("archived", false).eq("removed", false)
      .lt("stage_since", cutoff);
  }

  const { data: vehicleRows } = await db.from("vehicles")
    .select("*").eq("archived", false).limit(HARD_CAP);
  const vehicles = vehicleRows ?? [];
  const ids = vehicles.map((v) => v.id);

  // Scoped to the cars actually on the board. These used to select the whole
  // table and filter in memory here, which meant every message and every
  // stage change ever recorded - including those belonging to archived cars -
  // travelled in every poll, and would silently hit PostgREST's row cap once
  // the tables grew.
  const [cres, msgs, tres, lres, evs, docs, stres, invs] = await Promise.all([
    db.from("clients").select("*").order("name").limit(HARD_CAP),
    forCars("messages", ids, "created_at", true),
    db.from("notification_templates").select("*"),
    db.from("notification_log").select("*").order("created_at", { ascending: false }).limit(60),
    forCars("stage_events", ids, "occurred_at", true),
    forCars("documents", ids, "created_at", false),
    db.from("staff").select("id,name,username,active,last_seen_at").order("name"),
    forCars("invoices", ids, "created_at", false),
  ]);

  const stageById: Record<string, any> = {};
  for (const s of stages) stageById[s.id] = s;

  const msgByV: Record<string, any[]> = {};
  for (const m of msgs) (msgByV[m.vehicle_id] ??= []).push(m);
  const evByV: Record<string, any[]> = {};
  for (const e of evs) (evByV[e.vehicle_id] ??= []).push(e);
  const docByV: Record<string, any[]> = {};
  for (const d of docs) (docByV[d.vehicle_id] ??= []).push(d);
  // Newest first, so the first non-void row is the one that counts. Voided
  // invoices stay in the table as the record and are skipped here.
  const invByV: Record<string, any> = {};
  for (const i of invs) {
    if (i.status === "void") continue;
    if (!invByV[i.vehicle_id]) invByV[i.vehicle_id] = i;
  }

  const cars = vehicles.map((v) => {
    const mine = msgByV[v.id] ?? [];
    return {
      id: v.id,
      client_id: v.client_id,
      chassis: v.chassis,
      description: v.description,
      plate_no: v.plate_no ?? "",
      workshop: v.workshop ?? "",
      eta_ready: v.eta_ready ?? "",
      office_note: v.office_note ?? "",
      stage: v.stage_id,
      days: daysSince(v.stage_since),
      hold: v.hold_reason ?? "",
      is_sample: !!v.is_sample,
      history: (evByV[v.id] ?? []).map((e) => ({
        when: dayMonth(e.occurred_at),
        what: stageById[e.stage_id]?.op_label ?? e.stage_id,
        who: e.actor ?? "",
        note: e.note ?? "",
      })),
      docs: (docByV[v.id] ?? []).map((d) => ({
        id: d.id, name: d.name, client_visible: d.client_visible,
        size: d.size_bytes, at: dayMonth(d.created_at), by: d.uploaded_by,
        content_type: d.content_type ?? "", stage_id: d.stage_id ?? "",
      })),
      messages: mine.map((m) => ({ from: m.sender, body: m.body, at: stamp(m.created_at) })),
      unread: mine.filter((m) => m.sender === "client" && !m.read_by_office).length,
      invoice: invByV[v.id]
        ? { ...forClient(invByV[v.id]), by: invByV[v.id].paid_by ?? "", since: daysSince(invByV[v.id].created_at) }
        : null,
    };
  });

  const s = await settings();

  return {
    me,
    stages,
    clients: cres.data ?? [],
    cars,
    templates: tres.data ?? [],
    log: lres.data ?? [],
    staff: stres.data ?? [],
    payment: {
      mode: s.payment_visible_mode ?? "amount",
      stage_id: s.payment_visible_stage ?? "",
      // The board says so plainly rather than letting somebody set an amount
      // and wonder why no client can pay it.
      live: !!Deno.env.get("STRIPE_SECRET_KEY"),
    },
  };
}

/* ------------------------------------------------------------------ routes */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const path = routeOf(req);

  // Before the shared JSON parse, because Stripe signs the exact bytes it
  // sent and reading the body any other way loses them. This route carries no
  // bearer token: the signature is the authentication.
  if (path === "/api/stripe/webhook" && req.method === "POST") {
    try {
      const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
      if (!secret) return json({ error: "not configured" }, 400);
      const raw = await req.text();
      if (!(await stripeSigned(raw, req.headers.get("stripe-signature") ?? "", secret))) {
        return json({ error: "bad signature" }, 400);
      }
      const ev = JSON.parse(raw || "{}");
      if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
        const sess = ev.data?.object ?? {};
        const invoiceId = str(sess.metadata?.invoice_id ?? sess.client_reference_id ?? "", 80);
        if (invoiceId) {
          // Scoped to unpaid, so a replayed event cannot move paid_at.
          await db.from("invoices").update({
            status: "paid",
            paid_at: new Date().toISOString(),
            paid_by: "Stripe",
            stripe_payment_intent: str(sess.payment_intent ?? "", 120) || null,
          }).eq("id", invoiceId).eq("status", "unpaid");
        }
      }
      return json({ received: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  try {
    if (path === "/" || path === "" || path === "/health") {
      return json({ service: "plateline", ok: true });
    }

    /* ------------------------------------------------------------- sign in */

    // Username and password, not a passcode on its own. A passcode alone had
    // to be unique across everyone, because it was the only thing identifying
    // who was signing in: two people who chose the same one became the same
    // person, and the stage history named whichever of them the scan reached
    // first.
    if (path === "/api/login" && req.method === "POST") {
      const username = str(body.username, 60).toLowerCase();
      const passcode = String(body.passcode ?? "");
      if (!username || !passcode) return json({ error: "Enter your username and password." }, 400);

      if (await tooManyAttempts(username)) {
        return json({ error: "Too many attempts. Wait fifteen minutes and try again." }, 429);
      }

      const { data: who } = await db.from("staff")
        .select("id,name,username,passcode_sha256,passcode_hash,active")
        .eq("username", username).eq("active", true).maybeSingle();

      // Both halves are checked even when the username is unknown, so a wrong
      // username and a wrong password take the same time and say the same
      // thing. Which half was wrong is not the caller's business.
      const ok = await passcodeMatches(who, passcode);
      if (!who || !ok) {
        await noteFailure(username);
        return json({ error: "That username and password do not match." }, 401);
      }

      // A sign-in against the old hash is the one moment the plain passcode is
      // in hand, so it is the moment to store it properly.
      if (!who.passcode_hash) {
        await db.from("staff")
          .update({ passcode_hash: await hashPasscode(passcode), passcode_sha256: null })
          .eq("id", who.id);
      }

      await clearFailures(username);
      await rememberOrigin(req);
      return json({ token: await mint("op." + who.id), name: who.name });
    }

    /* ------------------------------------------------------------- client */

    if (path.startsWith("/api/client/")) {
      const cid = await clientIdOf(req);
      if (!cid) return json({ error: "not signed in" }, 401);

      if (path === "/api/client/state") {
        const { data: c } = await db.from("clients")
          .select("id,name,first_name,notify_sms,notify_email").eq("id", cid).maybeSingle();
        const { data: stages } = await db.from("stages").select("*").order("ord");

        // office_note is deliberately absent from this select. A client page
        // needs no login to reach, so the internal note must not be in the
        // payload at all - not merely hidden by the markup.
        const { data: vs } = await db.from("vehicles")
          .select("id,chassis,description,plate_no,eta_ready,stage_id,stage_since,hold_reason")
          .eq("client_id", cid).eq("removed", false).order("created_at");

        const stageById: Record<string, any> = {};
        for (const s of stages ?? []) stageById[s.id] = s;

        const canPay = !!Deno.env.get("STRIPE_SECRET_KEY");

        const vehicles = [];
        for (const v of vs ?? []) {
          const [{ data: evs }, { data: ms }, { data: docs }, { data: inv }] = await Promise.all([
            db.from("stage_events").select("*").eq("vehicle_id", v.id).order("occurred_at"),
            db.from("messages").select("*").eq("vehicle_id", v.id).order("created_at"),
            db.from("documents").select("id,name,created_at,content_type,stage_id")
              .eq("vehicle_id", v.id).eq("client_visible", true).order("created_at", { ascending: false }),
            db.from("invoices").select("*").eq("vehicle_id", v.id)
              .neq("status", "void").order("created_at", { ascending: false }).limit(1).maybeSingle(),
          ]);
          // An amount the client is not meant to see yet is left out of the
          // payload entirely, not hidden by the markup. Paid ones always show,
          // so a receipt does not disappear when the car moves on.
          const showable = inv && (inv.status === "paid" || await paymentVisible(v.stage_id, stages ?? []));
          vehicles.push({
            id: v.id, chassis: v.chassis, description: v.description,
            plate_no: v.plate_no ?? "", eta_ready: v.eta_ready ?? "",
            stage: v.stage_id, days: daysSince(v.stage_since), hold: v.hold_reason ?? "",
            invoice: showable ? forClient(inv) : null,
            can_pay: canPay,
            history: (evs ?? []).map((e) => ({
              when: dayMonth(e.occurred_at),
              what: stageById[e.stage_id]?.client_label ?? e.stage_id,
            })),
            docs: (docs ?? []).map((d) => ({
              id: d.id, name: d.name, at: dayMonth(d.created_at),
              content_type: d.content_type ?? "", stage_id: d.stage_id ?? "",
            })),
            messages: (ms ?? []).map((m) => ({ from: m.sender, body: m.body, at: stamp(m.created_at) })),
          });
        }
        await db.from("messages").update({ read_by_client: true })
          .in("vehicle_id", (vs ?? []).map((v) => v.id)).eq("sender", "office");

        return json({ client: c, stages, vehicles });
      }

      if (path === "/api/client/message" && req.method === "POST") {
        const text = str(body.body, 4000);
        if (!text) return json({ error: "empty" }, 400);
        const { data: v } = await db.from("vehicles").select("id")
          .eq("id", str(body.vehicle_id, 80)).eq("client_id", cid).maybeSingle();
        if (!v) return json({ error: "no such car" }, 404);
        await db.from("messages").insert({ vehicle_id: v.id, sender: "client", body: text });
        return json({ ok: true });
      }

      // The client decides how they are reached. The office cannot silently
      // put someone back on SMS they switched off.
      if (path === "/api/client/prefs" && req.method === "POST") {
        await db.from("clients").update({
          notify_sms: !!body.notify_sms,
          notify_email: !!body.notify_email,
        }).eq("id", cid);
        return json({ ok: true });
      }

      // Hands back a Stripe Checkout URL for one car. Everything that decides
      // the price is read here, from the invoice row: an amount posted by the
      // browser is an amount the customer can edit.
      if (path === "/api/client/checkout" && req.method === "POST") {
        const key = Deno.env.get("STRIPE_SECRET_KEY");
        if (!key) return json({ error: "Card payments are not switched on yet." }, 400);

        const { data: v } = await db.from("vehicles")
          .select("id,description,stage_id").eq("id", str(body.vehicle_id, 80))
          .eq("client_id", cid).eq("removed", false).maybeSingle();
        if (!v) return json({ error: "no such car" }, 404);

        const { data: stages } = await db.from("stages").select("id,ord").order("ord");
        if (!(await paymentVisible(v.stage_id, stages ?? []))) {
          return json({ error: "That is not due yet." }, 400);
        }

        const { data: inv } = await db.from("invoices").select("*")
          .eq("vehicle_id", v.id).eq("status", "unpaid").limit(1).maybeSingle();
        if (!inv) return json({ error: "There is nothing to pay on that car." }, 400);

        const s = await settings();
        const base = (s.site_url ?? "").replace(/\/+$/, "");
        const form = new URLSearchParams({
          mode: "payment",
          success_url: base + "/my.html?paid=1",
          cancel_url: base + "/my.html",
          client_reference_id: inv.id,
          "metadata[invoice_id]": inv.id,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": inv.currency ?? "aud",
          "line_items[0][price_data][unit_amount]": String(inv.amount_cents),
          "line_items[0][price_data][product_data][name]": "Compliance - " + v.description,
          "line_items[0][price_data][product_data][description]":
            "Includes GST of " + money(inv.gst_cents),
        });

        const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok || !out.url) return json({ error: "Could not start the payment." }, 400);

        await db.from("invoices").update({ stripe_session_id: out.id }).eq("id", inv.id);
        return json({ url: out.url });
      }

      if (path === "/api/client/doc" && req.method === "POST") {
        const { data: d } = await db.from("documents")
          .select("storage_path,vehicle_id,client_visible").eq("id", str(body.id, 80)).maybeSingle();
        if (!d || !d.client_visible) return json({ error: "not found" }, 404);
        const { data: v } = await db.from("vehicles").select("id")
          .eq("id", d.vehicle_id).eq("client_id", cid).maybeSingle();
        if (!v) return json({ error: "not found" }, 404);
        const { data: signed } = await db.storage.from("documents").createSignedUrl(d.storage_path, 300);
        return json({ url: signed?.signedUrl ?? "" });
      }

      return json({ error: "unknown" }, 404);
    }

    /* ----------------------------------------------------------- operator */

    if (path.startsWith("/api/op/")) {
      const me = await staffOf(req);
      if (!me) return json({ error: "not signed in" }, 401);
      await rememberOrigin(req);

      if (path === "/api/op/state") return json(await boardState({ name: me.name }));

      /* --- the car ------------------------------------------------------ */

      // One endpoint creates and updates, because the form is the same form.
      if (path === "/api/op/vehicle/save" && req.method === "POST") {
        const description = str(body.description, 120);
        if (!description) return json({ error: "The car needs a description." }, 400);

        const fields = {
          chassis: str(body.chassis, 40) || "not recorded",
          description,
          plate_no: str(body.plate_no, 20),
          workshop: str(body.workshop, 80),
          eta_ready: nullable(body.eta_ready, 10),
          office_note: str(body.office_note, 2000),
        };

        if (body.id) {
          const { error } = await db.from("vehicles").update(fields).eq("id", str(body.id, 80));
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true, id: body.id });
        }

        // New car. Either onto a client already on the books, or onto a new one.
        let clientId = str(body.client_id, 80);
        if (!clientId) {
          const name = str(body.name, 80);
          if (!name) return json({ error: "Pick a client, or type a new client's name." }, 400);
          const { data: c, error: ce } = await db.from("clients").insert({
            name, first_name: name.split(/\s+/)[0],
            company: str(body.company, 80),
            phone: nullable(body.phone, 40),
            email: nullable(body.email, 120),
          }).select().single();
          if (ce || !c) return json({ error: ce?.message ?? "Could not save that client." }, 400);
          clientId = c.id;
        }

        const stage = str(body.stage, 40) || "landed";
        const { data: v, error: ve } = await db.from("vehicles")
          .insert({ ...fields, client_id: clientId, stage_id: stage }).select().single();
        if (ve || !v) return json({ error: ve?.message ?? "Could not save that car." }, 400);

        await db.from("stage_events").insert({
          vehicle_id: v.id, stage_id: stage, actor: me.name, note: "Added to the board",
        });
        const { data: c } = await db.from("clients").select("*").eq("id", clientId).maybeSingle();
        const r = await notifyStage(v, c, stage);
        return json({ ok: true, id: v.id, link: await linkFor(clientId), sent: r.sent, held: r.held });
      }

      if (path === "/api/op/vehicle/delete" && req.method === "POST") {
        await db.from("vehicles").update({ archived: true, removed: true })
          .eq("id", str(body.id, 80));
        return json({ ok: true });
      }

      // Any stage, in either direction. Going backwards is a correction, so
      // it is recorded but the client is not told their car went backwards.
      if (path === "/api/op/vehicle/stage" && req.method === "POST") {
        const { data: v } = await db.from("vehicles").select("*").eq("id", str(body.vehicle_id, 80)).maybeSingle();
        if (!v) return json({ error: "no such car" }, 404);
        const { data: stages } = await db.from("stages").select("*").order("ord");
        const list = stages ?? [];
        const from = list.findIndex((s) => s.id === v.stage_id);
        const toIdx = list.findIndex((s) => s.id === str(body.stage_id, 40));
        if (toIdx < 0) return json({ error: "no such stage" }, 400);
        const to = list[toIdx];
        if (toIdx === from) return json({ error: "That car is already there." }, 400);

        const forward = toIdx > from;
        const note = str(body.note, 300);

        await db.from("vehicles").update({
          stage_id: to.id,
          stage_since: new Date().toISOString(),
          ...(forward ? { hold_reason: "" } : {}),
        }).eq("id", v.id);

        await db.from("stage_events").insert({
          vehicle_id: v.id, stage_id: to.id, actor: me.name,
          note: note || (forward ? "" : "Moved back"),
        });

        if (!forward) return json({ ok: true, stage: to.op_label, back: true, sent: false, held: false });

        await db.from("messages").insert({
          vehicle_id: v.id, sender: "system", body: to.client_label,
          read_by_office: true, read_by_client: true,
        });
        const { data: c } = await db.from("clients").select("*").eq("id", v.client_id).maybeSingle();
        const r = await notifyStage(v, c, to.id);
        return json({ ok: true, stage: to.op_label, back: false, sent: r.sent, held: r.held });
      }

      // Waiting on somebody, or no longer waiting. This is the field that
      // answers the phone call before it is made, and it finally has a way in.
      if (path === "/api/op/vehicle/hold" && req.method === "POST") {
        await db.from("vehicles")
          .update({ hold_reason: str(body.hold_reason, 200) })
          .eq("id", str(body.vehicle_id, 80));
        return json({ ok: true });
      }

      /* --- the client --------------------------------------------------- */

      if (path === "/api/op/client/save" && req.method === "POST") {
        const name = str(body.name, 80);
        if (!name) return json({ error: "A client needs a name." }, 400);
        const fields = {
          name, first_name: str(body.first_name, 40) || name.split(/\s+/)[0],
          company: str(body.company, 80),
          phone: nullable(body.phone, 40),
          email: nullable(body.email, 120),
          note: str(body.note, 2000),
        };
        if (body.id) {
          const { error } = await db.from("clients").update(fields).eq("id", str(body.id, 80));
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true, id: body.id });
        }
        const { data, error } = await db.from("clients").insert(fields).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, id: data.id });
      }

      // Archives their cars rather than deleting: the history of a car that
      // was complied is worth keeping even after the client goes.
      if (path === "/api/op/client/delete" && req.method === "POST") {
        const id = str(body.id, 80);
        await db.from("vehicles").update({ archived: true, removed: true }).eq("client_id", id);
        await db.from("client_access").delete().eq("client_id", id);
        return json({ ok: true });
      }

      if (path === "/api/op/link" && req.method === "POST") {
        return json({ link: await linkFor(str(body.client_id, 80)) });
      }

      // Cuts the old link dead and issues a new one - for when a client
      // forwards their link to somebody it was not meant for.
      if (path === "/api/op/link/reset" && req.method === "POST") {
        const id = str(body.client_id, 80);
        await db.from("client_access").delete().eq("client_id", id);
        return json({ link: await linkFor(id) });
      }

      /* --- messages ----------------------------------------------------- */

      if (path === "/api/op/reply" && req.method === "POST") {
        const text = str(body.body, 4000);
        if (!text) return json({ error: "empty" }, 400);
        await db.from("messages").insert({
          vehicle_id: str(body.vehicle_id, 80), sender: "office", body: text, read_by_office: true,
        });
        await db.from("messages").update({ read_by_office: true })
          .eq("vehicle_id", str(body.vehicle_id, 80)).eq("sender", "client");
        return json({ ok: true });
      }

      if (path === "/api/op/read" && req.method === "POST") {
        await db.from("messages").update({ read_by_office: true })
          .eq("vehicle_id", str(body.vehicle_id, 80)).eq("sender", "client");
        return json({ ok: true });
      }

      /* --- documents ---------------------------------------------------- */

      if (path === "/api/op/doc/sign" && req.method === "POST") {
        const vid = str(body.vehicle_id, 80);
        const clean = str(body.name, 120).replace(/[^\w.\- ]+/g, "_") || "document";
        const p = vid + "/" + Date.now() + "-" + clean;
        const { data, error } = await db.storage.from("documents").createSignedUploadUrl(p);
        if (error) return json({ error: error.message }, 400);
        return json({ url: data.signedUrl, path: p });
      }

      if (path === "/api/op/doc/save" && req.method === "POST") {
        // The step the car is at right now is the step this photo shows.
        const forVehicle = str(body.vehicle_id, 80);
        const { data: atCar } = await db.from("vehicles")
          .select("stage_id").eq("id", forVehicle).maybeSingle();
        const { data, error } = await db.from("documents").insert({
          stage_id: atCar?.stage_id ?? null,
          vehicle_id: forVehicle,
          name: str(body.name, 120),
          storage_path: str(body.path, 300),
          content_type: str(body.content_type, 120),
          size_bytes: Number(body.size) || 0,
          client_visible: !!body.client_visible,
          uploaded_by: me.name,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, id: data.id });
      }

      if (path === "/api/op/doc/visible" && req.method === "POST") {
        await db.from("documents").update({ client_visible: !!body.client_visible })
          .eq("id", str(body.id, 80));
        return json({ ok: true });
      }

      if (path === "/api/op/doc/url" && req.method === "POST") {
        const { data: d } = await db.from("documents").select("storage_path").eq("id", str(body.id, 80)).maybeSingle();
        if (!d) return json({ error: "not found" }, 404);
        const { data: signed } = await db.storage.from("documents").createSignedUrl(d.storage_path, 300);
        return json({ url: signed?.signedUrl ?? "" });
      }

      if (path === "/api/op/doc/delete" && req.method === "POST") {
        const { data: d } = await db.from("documents").select("storage_path").eq("id", str(body.id, 80)).maybeSingle();
        if (d) await db.storage.from("documents").remove([d.storage_path]);
        await db.from("documents").delete().eq("id", str(body.id, 80));
        return json({ ok: true });
      }

      /* --- money -------------------------------------------------------- */

      // Sets what a car costs. The figure typed is the total the customer
      // pays, GST included, which is what they must be quoted; the GST inside
      // it is worked out here rather than added on.
      if (path === "/api/op/invoice/save" && req.method === "POST") {
        const vid = str(body.vehicle_id, 80);
        const cents = centsFrom(body.amount);
        if (!cents) return json({ error: "Enter an amount." }, 400);

        // limit(1) throughout: a car can collect more than one paid invoice
        // over its life, and maybeSingle() treats a second row as an error.
        const { data: settled } = await db.from("invoices").select("id")
          .eq("vehicle_id", vid).eq("status", "paid").limit(1).maybeSingle();
        if (settled) return json({ error: "That car is already paid." }, 400);

        const fields = { amount_cents: cents, gst_cents: gstWithin(cents), created_by: me.name };
        const { data: open } = await db.from("invoices").select("id")
          .eq("vehicle_id", vid).eq("status", "unpaid").limit(1).maybeSingle();

        if (open) {
          const { error } = await db.from("invoices").update(fields).eq("id", open.id);
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true, id: open.id });
        }
        const { data, error } = await db.from("invoices")
          .insert({ ...fields, vehicle_id: vid }).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, id: data.id });
      }

      // Paid some other way - a transfer, cash at the counter. Recorded as
      // who marked it rather than pretending Stripe saw it.
      if (path === "/api/op/invoice/paid" && req.method === "POST") {
        const { error } = await db.from("invoices").update({
          status: "paid", paid_at: new Date().toISOString(), paid_by: me.name,
        }).eq("id", str(body.id, 80)).eq("status", "unpaid");
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (path === "/api/op/invoice/void" && req.method === "POST") {
        const { error } = await db.from("invoices").update({ status: "void" })
          .eq("id", str(body.id, 80)).eq("status", "unpaid");
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // When the amount appears on the client's page: as soon as one is set,
      // or not until the car reaches a nominated stage.
      if (path === "/api/op/payment/settings" && req.method === "POST") {
        const mode = str(body.mode, 10) === "stage" ? "stage" : "amount";
        await putSetting("payment_visible_mode", mode);
        await putSetting("payment_visible_stage", str(body.stage_id, 40));
        return json({ ok: true });
      }

      /* --- the wording -------------------------------------------------- */

      // "Written once and sent for every car" was only true if somebody could
      // write it. Now they can.
      if (path === "/api/op/template/save" && req.method === "POST") {
        const { error } = await db.from("notification_templates").update({
          sms_body: str(body.sms_body, 600),
          email_subject: str(body.email_subject, 200),
          email_body: str(body.email_body, 4000),
        }).eq("stage_id", str(body.stage_id, 40));
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (path === "/api/op/template/toggle" && req.method === "POST") {
        await db.from("notification_templates").update({ enabled: !!body.enabled })
          .eq("stage_id", str(body.stage_id, 40));
        return json({ ok: true });
      }

      // The words the client reads for a stage belong to the business, not to
      // whoever wrote the first draft.
      if (path === "/api/op/stage/save" && req.method === "POST") {
        const { error } = await db.from("stages").update({
          op_label: str(body.op_label, 60),
          client_label: str(body.client_label, 60),
          blurb: str(body.blurb, 600),
          you_note: str(body.you_note, 600),
        }).eq("id", str(body.id, 40));
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      /* --- people and housekeeping -------------------------------------- */

      if (path === "/api/op/staff/save" && req.method === "POST") {
        const name = str(body.name, 60);
        if (!name) return json({ error: "A name is needed." }, 400);
        const pass = String(body.passcode ?? "");
        // Stored lowercase so the sign-in lookup can be a plain equality
        // rather than a pattern match, where _ and % would be wildcards.
        const username = str(body.username, 60).toLowerCase();
        if (username && !/^[a-z0-9._-]{3,60}$/.test(username)) {
          return json({ error: "Usernames use letters, numbers, dots, dashes and underscores, 3 characters or more." }, 400);
        }

        if (body.id) {
          const patch: any = { name, active: body.active !== false };
          if (username) patch.username = username;
          if (pass) {
            if (pass.length < 8) return json({ error: "A password needs at least 8 characters." }, 400);
            patch.passcode_hash = await hashPasscode(pass);
            patch.passcode_sha256 = null;
          }
          const { error } = await db.from("staff").update(patch).eq("id", str(body.id, 80));
          if (error) return json({ error: usernameTaken(error) }, 400);
          return json({ ok: true });
        }

        if (!username) return json({ error: "Give them a username." }, 400);
        if (pass.length < 8) return json({ error: "Give them a password of at least 8 characters." }, 400);
        const { error } = await db.from("staff")
          .insert({ name, username, passcode_hash: await hashPasscode(pass) });
        if (error) return json({ error: usernameTaken(error) }, 400);
        return json({ ok: true });
      }

      // Never the last one, or nobody can get back in.
      if (path === "/api/op/staff/delete" && req.method === "POST") {
        const { count } = await db.from("staff").select("id", { count: "exact", head: true }).eq("active", true);
        if ((count ?? 0) <= 1) return json({ error: "That is the last sign-in. Add another before removing this one." }, 400);
        await db.from("staff").delete().eq("id", str(body.id, 80));
        return json({ ok: true });
      }

      if (path === "/api/op/clear_samples" && req.method === "POST") {
        await db.from("clients").delete().eq("is_sample", true);
        return json({ ok: true });
      }

      return json({ error: "unknown" }, 404);
    }

    return json({ error: "unknown route" }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

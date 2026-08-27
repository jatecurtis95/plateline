/* Plateline - the client's page.

   One person can have more than one car being complied, so this is a list
   with a picker, not a single record. Everything here is theirs: no office
   note, no workshop name, no job number - the API does not send them.

   The tracker is deliberately built like a parcel-tracking page: every step
   of the job in one vertical list, the finished ones ticked, the one that is
   happening now highlighted. A customer should be able to read it without
   asking us anything. */

var API = window.PLATELINE_API || "https://eivyrjzdxtoaqpkwuhta.supabase.co/functions/v1/plateline";
var KEY = "plateline_client_token";
var S = null, sel = 0, tab = "car", toastTimer = null;

function $(i) { return document.getElementById(i); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function toast(m) {
  var t = $("toast"); t.textContent = m; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2600);
}
function tok() { try { return localStorage.getItem(KEY); } catch (e) { return window.__t || null; } }
function setTok(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) { window.__t = v; } }
function fmtDate(d) {
  if (!d) return "";
  var x = new Date(d + "T00:00:00");
  return isNaN(x) ? d : x.toLocaleDateString("en-AU", { day: "numeric", month: "long" });
}

// The link carries the token once; it is put away and taken out of the
// address bar so it is not left sitting in history or a shared screenshot.
(function () {
  var u = new URL(location.href), t = u.searchParams.get("t");
  if (t) {
    setTok(t); u.searchParams.delete("t");
    history.replaceState({}, "", u.pathname + (u.search || "") + u.hash);
  }
  // Coming back from Stripe. This only says the customer finished at Stripe -
  // the record is marked paid by the webhook, not by anyone arriving here,
  // so the page still shows whatever the API says a moment later.
  if (u.searchParams.get("paid")) {
    u.searchParams.delete("paid");
    history.replaceState({}, "", u.pathname + (u.search || "") + u.hash);
    setTimeout(function () { toast("Thank you. Your payment is going through."); }, 300);
  }
})();

async function api(path, body) {
  var o = { method: body ? "POST" : "GET", headers: { "content-type": "application/json" } };
  var t = tok(); if (t) o.headers.authorization = "Bearer " + t;
  if (body) o.body = JSON.stringify(body);
  var r;
  try { r = await fetch(API + path, o); } catch (e) { return { error: "unreachable" }; }
  if (r.status === 401) return { error: "expired" };
  return await r.json().catch(function () { return {}; });
}

function gate(msg) {
  $("app").hidden = true; $("gate").hidden = false;
  if (msg) $("gate-msg").textContent = msg;
}

function typing() {
  var a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

async function load(force) {
  if (!tok()) return gate();
  var d = await api("/api/client/state");
  if (!d || d.error) {
    return gate(d && d.error === "unreachable"
      ? "Cannot reach the server just now. Try again in a moment."
      : "That link has expired. Ask us to send you a fresh one.");
  }
  S = d; $("gate").hidden = true; $("app").hidden = false;
  if (typing() && !force) return;
  draw();
}

/* ---------------------------------------------------------------- photos */

/* Signed URLs are fetched once per document and kept for the life of the
   page, so the 45-second refresh does not re-sign every photo. */
var shotUrl = {};

function isPhoto(d) {
  if (d && d.content_type) return /^image\//i.test(d.content_type);
  return /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i.test(String((d && d.name) || ""));
}

/* A document is only pinned to a step if the API says so. It does not yet,
   so everything lands in the unplaced bucket and is shown in one strip. The
   moment documents carry a stage this groups itself. */
function docStage(d) { return (d && (d.stage_id || d.stage)) || ""; }

function shotStrip(list) {
  if (!list.length) return "";
  return '<div class="tshots">' + list.map(function (d) {
    return '<button class="shot" data-shot="' + esc(d.id) + '" title="' + esc(d.name) + '">' +
      '<img alt="' + esc(d.name) + '" data-img="' + esc(d.id) + '">' +
      '<span class="shot-fall">' + esc(d.name) + "</span></button>";
  }).join("") + "</div>";
}

/* Fills in the thumbnails after the page is drawn. */
function fillShots() {
  document.querySelectorAll("[data-img]").forEach(async function (img) {
    var id = img.getAttribute("data-img");
    if (!shotUrl[id]) {
      var r = await api("/api/client/doc", { id: id });
      if (!r || !r.url) { img.closest(".shot").classList.add("failed"); return; }
      shotUrl[id] = r.url;
    }
    img.addEventListener("error", function () { img.closest(".shot").classList.add("failed"); });
    img.src = shotUrl[id];
  });
}

/* ------------------------------------------------------------- the steps */

/* Best effort only: if a history line names this step, show when it
   happened. No match, no date - never a guessed one. */
function stepDate(v, st) {
  var lab = String(st.client_label || "").toLowerCase();
  if (!lab) return "";
  var hit = null;
  (v.history || []).forEach(function (e) {
    if (String(e.what || "").toLowerCase().indexOf(lab) > -1) hit = e;
  });
  return hit ? hit.when : "";
}

/* ---------------------------------------------------------------- paying */

/* The amount, and a way to pay it. The API leaves the invoice out of the
   payload altogether until the client is meant to see it, so there is nothing
   to hide here - if `invoice` is absent there is nothing to show.

   The figure is whatever the API says. Nothing here computes a price, and
   nothing here is sent back when paying: the amount charged is read from the
   invoice server-side, where the customer cannot reach it. */
function payCard(v) {
  var inv = v.invoice;
  if (!inv) return "";

  if (inv.status === "paid") {
    return '<div class="ccard"><div class="lbl" style="margin-bottom:8px">Payment</div>' +
      '<div class="cbox"><b>' + esc(inv.amount) + "</b> paid" +
      (inv.paid_at ? " on " + esc(inv.paid_at) : "") + ". Thank you." +
      '<br><span style="color:var(--faint)">Includes GST of ' + esc(inv.gst) + "</span></div></div>";
  }

  return '<div class="ccard"><div class="lbl" style="margin-bottom:8px">Payment</div>' +
    '<div class="cnow"><div class="k">Amount due</div>' +
    '<div class="v">' + esc(inv.amount) + "</div>" +
    '<div class="s">Includes GST of ' + esc(inv.gst) + "</div></div>" +
    (v.can_pay
      ? '<button class="btn" data-pay="' + esc(v.id) + '" style="margin-top:12px">Pay now</button>' +
        '<div style="font-size:11.5px;color:var(--faint);margin-top:8px">' +
        "You will be taken to Stripe to pay by card, then brought back here.</div>"
      : '<div class="cbox" style="margin-top:12px">Please contact the office to arrange payment.</div>') +
    "</div>";
}

function tracker(v, here, done, byStage, loose) {
  return '<ol class="trk">' + S.stages.map(function (st, i) {
    var cls = i < here ? "done" : i === here ? (done ? "done" : "now") : "todo";
    var when = cls === "done" ? stepDate(v, st) : "";
    var mine = byStage[st.id] || [];
    // With nothing pinned to a step, the photos sit under whatever is
    // happening now, which is what a customer is looking for anyway.
    if (!mine.length && i === here) mine = loose;

    return '<li class="tstep ' + cls + '">' +
      '<span class="tmark"></span>' +
      '<span class="tbody">' +
      '<span class="tlab">' + esc(st.client_label) + "</span>" +
      (when ? '<span class="tsub">' + esc(when) + "</span>"
            : cls === "now" ? '<span class="tsub">Happening now</span>' : "") +
      (cls === "now" && st.blurb ? '<span class="tnote">' + esc(st.blurb) + "</span>" : "") +
      shotStrip(mine) +
      "</span></li>";
  }).join("") + "</ol>";
}

/* ------------------------------------------------------------------ draw */

function draw() {
  if (!S) return;
  var v = S.vehicles[sel];
  var st = v ? S.stages.filter(function (s) { return s.id === v.stage; })[0] : null;
  var here = v ? S.stages.map(function (s) { return s.id; }).indexOf(v.stage) : -1;
  var done = v ? S.stages[S.stages.length - 1].id === v.stage : false;

  var picker = S.vehicles.length > 1
    ? '<div class="cpick">' + S.vehicles.map(function (x, i) {
        return '<button data-pick="' + i + '"' + (i === sel ? ' class="on"' : "") + ">" + esc(x.description) + "</button>";
      }).join("") + "</div>"
    : "";

  var mark = '<svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<rect x="4.5" y="10.5" width="39" height="27" rx="5.5" stroke="currentColor" stroke-width="3"/>' +
    '<circle cx="11" cy="17" r="1.9" fill="currentColor"/><circle cx="37" cy="17" r="1.9" fill="currentColor"/>' +
    '<circle cx="11" cy="31" r="1.9" fill="currentColor"/><circle cx="37" cy="31" r="1.9" fill="currentColor"/>' +
    '<path d="M12 24h9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M31 24h5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="26" cy="24" r="4.5" fill="var(--accent)"/></svg>';

  var top = '<div class="ctop"><div class="logo">' + mark + "<span>Plateline</span></div>" +
    '<span style="font-size:12.5px;color:var(--mute)">' + esc(S.client ? S.client.name : "") + "</span></div>";

  if (!v) {
    $("app").innerHTML = '<div class="cwrap">' + top +
      '<div class="ccard"><p style="margin:0;color:var(--mute)">No car on your account yet.</p></div></div>';
    return;
  }

  var docs = v.docs || [];
  var photos = docs.filter(isPhoto), papers = docs.filter(function (d) { return !isPhoto(d); });
  var byStage = {}, loose = [];
  photos.forEach(function (d) {
    var sid = docStage(d);
    if (sid) { (byStage[sid] = byStage[sid] || []).push(d); } else { loose.push(d); }
  });

  var body;
  if (tab === "msg") {
    body = '<div class="ccard" style="padding:0">' +
      '<div class="thread" id="c-thread" style="background:none;max-height:52vh"></div>' +
      '<div class="composer"><textarea id="c-msg" rows="1" placeholder="Ask about your car"></textarea>' +
      '<button class="btn" id="c-send">Send</button></div></div>';
  } else {
    var since = v.days === 0 ? "Updated today" : v.days === 1 ? "Since yesterday" : "Since " + v.days + " days ago";

    body = '<div class="ccard">' +
      '<h2 style="font-size:19px">' + esc(v.description) + "</h2>" +
      '<div class="mono" style="font-size:11px;color:var(--faint)">' + esc(v.chassis) +
      (v.plate_no ? " &middot; plate " + esc(v.plate_no) : "") + "</div>" +
      '<div class="cnow"><div class="k">' + (done ? "Complete" : "Right now") + "</div>" +
      '<div class="v">' + esc(st.client_label) + '</div><div class="s">' + esc(since) + "</div></div>" +
      (v.hold ? '<div class="cbox wait"><b>We are waiting on:</b> ' + esc(v.hold) + "</div>" : "") +
      (done ? "" : '<div class="cbox"><b>What happens next:</b> ' + esc(st.you_note) + "</div>") +
      (v.eta_ready ? '<div class="cbox"><b>Expected ready:</b> ' + esc(fmtDate(v.eta_ready)) + "</div>" : "") +
      "</div>" +

      payCard(v) +

      '<div class="ccard"><div class="lbl" style="margin-bottom:12px">Every step</div>' +
      tracker(v, here, done, byStage, loose) + "</div>" +

      (papers.length ? '<div class="ccard"><div class="lbl" style="margin-bottom:8px">Your documents</div>' +
        papers.map(function (d) {
          return '<div class="doc" style="padding:8px 0"><span class="nm">' + esc(d.name) + "</span>" +
            '<button class="btn quiet sm" data-doc="' + esc(d.id) + '">Open</button></div>';
        }).join("") + "</div>" : "") +

      '<div class="ccard"><div class="lbl" style="margin-bottom:8px">How we reach you</div>' +
      '<label class="toggle" style="display:flex;margin-bottom:8px"><input type="checkbox" id="p-sms"' +
      (S.client.notify_sms ? " checked" : "") + '><span class="track"></span><span>Text message</span></label>' +
      '<label class="toggle" style="display:flex"><input type="checkbox" id="p-email"' +
      (S.client.notify_email ? " checked" : "") + '><span class="track"></span><span>Email</span></label></div>';
  }

  $("app").innerHTML = '<div class="cwrap">' + top + picker +
    '<div class="cpick" style="margin-bottom:16px">' +
    '<button data-tab="car"' + (tab === "car" ? ' class="on"' : "") + ">My car</button>" +
    '<button data-tab="msg"' + (tab === "msg" ? ' class="on"' : "") + ">Messages</button></div>" +
    body + "</div>";

  document.querySelectorAll("[data-pick]").forEach(function (b) {
    b.addEventListener("click", function () { sel = +b.getAttribute("data-pick"); draw(); });
  });
  document.querySelectorAll("[data-tab]").forEach(function (b) {
    b.addEventListener("click", function () { tab = b.getAttribute("data-tab"); draw(); });
  });
  document.querySelectorAll("[data-doc]").forEach(function (b) {
    b.addEventListener("click", async function () {
      var r = await api("/api/client/doc", { id: b.getAttribute("data-doc") });
      if (r && r.url) window.open(r.url, "_blank"); else toast("That file is not available.");
    });
  });
  document.querySelectorAll("[data-pay]").forEach(function (b) {
    b.addEventListener("click", async function () {
      // Disabled straight away: a second click while Stripe is being asked
      // would open a second checkout for the same car.
      b.disabled = true;
      b.textContent = "Taking you to Stripe";
      var r = await api("/api/client/checkout", { vehicle_id: b.getAttribute("data-pay") });
      if (r && r.url) { location.href = r.url; return; }
      b.disabled = false;
      b.textContent = "Pay now";
      toast((r && r.error) || "Could not start the payment.");
    });
  });
  document.querySelectorAll("[data-shot]").forEach(function (b) {
    b.addEventListener("click", function () {
      var u = shotUrl[b.getAttribute("data-shot")];
      if (u) window.open(u, "_blank"); else toast("That photo is not available.");
    });
  });

  if (tab === "msg") {
    var el = $("c-thread");
    el.innerHTML = v.messages.length
      ? v.messages.map(function (mm) {
          if (mm.from === "system") return '<div class="msg sys">' + esc(mm.body) + "</div>";
          return '<div class="msg ' + (mm.from === "client" ? "us" : "them") + '">' + esc(mm.body) +
            '<span class="meta">' + (mm.from === "office" ? "Compliance team" : "You") +
            " · " + esc(mm.at) + "</span></div>";
        }).join("")
      : '<div class="msg sys">No messages yet.</div>';
    el.scrollTop = el.scrollHeight;
    $("c-send").addEventListener("click", async function () {
      var t = $("c-msg").value.trim(); if (!t) return $("c-msg").focus();
      await api("/api/client/message", { vehicle_id: v.id, body: t });
      $("c-msg").value = ""; tab = "msg"; await load(true); toast("Sent");
    });
    $("c-msg").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("c-send").click(); }
    });
  } else {
    fillShots();
    ["p-sms", "p-email"].forEach(function (id) {
      $(id).addEventListener("change", async function () {
        await api("/api/client/prefs", { notify_sms: $("p-sms").checked, notify_email: $("p-email").checked });
        toast("Saved");
      });
    });
  }
}

load();
setInterval(load, 45000);

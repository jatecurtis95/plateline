/* Plateline - the client's page.

   One person can have more than one car being complied, so this is a list
   with a picker, not a single record. Everything here is theirs: no office
   note, no workshop name, no job number - the API does not send them. */

var API = window.PLATELINE_API || "https://eivyrjzdxtoaqpkwuhta.supabase.co/functions/v1/plateline";
var KEY = "plateline_client_token";
var S = null, sel = 0, tab = "car", toastTimer = null;
var PHASES = ["Paperwork", "Workshop", "Inspection", "Ready"];

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

function draw() {
  if (!S) return;
  var v = S.vehicles[sel];
  var st = v ? S.stages.filter(function (s) { return s.id === v.stage; })[0] : null;
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

  var body;
  if (tab === "msg") {
    body = '<div class="ccard" style="padding:0">' +
      '<div class="thread" id="c-thread" style="background:none;max-height:52vh"></div>' +
      '<div class="composer"><textarea id="c-msg" rows="1" placeholder="Ask about your car"></textarea>' +
      '<button class="btn" id="c-send">Send</button></div></div>';
  } else {
    var steps = PHASES.map(function (t, i) {
      var cls = i < st.phase ? "done" : i === st.phase ? (done ? "done" : "now") : "";
      return '<li class="step ' + cls + '"><span class="dot"></span><span class="t">' + esc(t) + "</span></li>";
    }).join("");
    var since = v.days === 0 ? "Updated today" : v.days === 1 ? "Since yesterday" : "Since " + v.days + " days ago";

    body = '<div class="ccard">' +
      '<h2 style="font-size:19px">' + esc(v.description) + "</h2>" +
      '<div class="mono" style="font-size:11px;color:var(--faint)">' + esc(v.chassis) +
      (v.plate_no ? " &middot; plate " + esc(v.plate_no) : "") + "</div>" +
      '<div class="cnow"><div class="k">' + (done ? "Complete" : "Right now") + "</div>" +
      '<div class="v">' + esc(st.client_label) + '</div><div class="s">' + esc(since) + "</div></div>" +
      '<ol class="steps">' + steps + "</ol>" +
      '<p class="cblurb">' + esc(st.blurb) + "</p>" +
      (v.hold ? '<div class="cbox wait"><b>Waiting on:</b> ' + esc(v.hold) + "</div>" : "") +
      '<div class="cbox"><b>Next:</b> ' + esc(st.you_note) + "</div>" +
      (v.eta_ready ? '<div class="cbox"><b>Expected ready:</b> ' + esc(fmtDate(v.eta_ready)) + "</div>" : "") +
      (v.docs.length ? '<div style="margin-top:16px"><div class="lbl">Your documents</div>' +
        v.docs.map(function (d) {
          return '<div class="doc" style="padding:8px 0"><span class="nm">' + esc(d.name) + "</span>" +
            '<button class="btn quiet sm" data-doc="' + d.id + '">Open</button></div>';
        }).join("") + "</div>" : "") +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--hair)">' +
      '<div class="lbl">History</div>' +
      v.history.slice().reverse().map(function (e) {
        return '<div class="ev" style="padding:5px 0;border:0"><span class="d">' + esc(e.when) +
          '</span><span class="w">' + esc(e.what) + "</span></div>";
      }).join("") + "</div>" +
      "</div>" +
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

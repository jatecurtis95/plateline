/* Plateline - the office board.

   Built on one rule: if a screen shows a field, a person can change it here.
   The previous version displayed a "waiting on" note and an expected date
   that nothing in the interface could set, which is why it felt like a
   picture of a database rather than a tool.

   Routing is on the hash, so the browser Back button works and a car can be
   linked to directly. */

var API = window.PLATELINE_API || "https://eivyrjzdxtoaqpkwuhta.supabase.co/functions/v1/plateline";
var KEY = "plateline_operator_token";
var S = { stages: [], cars: [], clients: [], templates: [], log: [], staff: [], me: {} };
var timer = null, toastTimer = null;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function tok() { try { return localStorage.getItem(KEY); } catch (e) { return window.__t || null; } }
function setTok(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) { window.__t = v; } }
function toast(m) {
  var t = $("toast"); t.textContent = m; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2600);
}
function initials(n) {
  var p = String(n || "").trim().split(/\s+/);
  return (((p[0] || "")[0] || "?") + ((p[1] || "")[0] || "")).toUpperCase();
}
function stageIdx(id) { for (var i = 0; i < S.stages.length; i++) if (S.stages[i].id === id) return i; return -1; }
function stageOf(id) { var i = stageIdx(id); return i > -1 ? S.stages[i] : null; }
function carById(id) { return S.cars.filter(function (c) { return c.id === id; })[0] || null; }
function clientById(id) { return S.clients.filter(function (c) { return c.id === id; })[0] || null; }
function carsOf(cid) { return S.cars.filter(function (c) { return c.client_id === cid; }); }
function ageChip(d) { return d >= 21 ? "chip bad" : d >= 14 ? "chip warn" : "chip"; }
function isLast(id) { return stageIdx(id) === S.stages.length - 1; }
function fmtDate(d) {
  if (!d) return "";
  var x = new Date(d + "T00:00:00");
  return isNaN(x) ? d : x.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

async function api(path, body) {
  var o = { method: body ? "POST" : "GET", headers: { "content-type": "application/json" } };
  var t = tok(); if (t) o.headers.authorization = "Bearer " + t;
  if (body) o.body = JSON.stringify(body);
  var r;
  try { r = await fetch(API + path, o); } catch (e) { toast("Cannot reach the server."); return null; }
  if (r.status === 401) { signOut(); return null; }
  return await r.json().catch(function () { return {}; });
}

/* ------------------------------------------------------------------ auth */

function signOut() {
  setTok(null); clearInterval(timer);
  $("app").hidden = true; $("gate").hidden = false; $("pc").value = "";
}
function signedIn() {
  $("gate").hidden = true; $("app").hidden = false;
  load(true); clearInterval(timer); timer = setInterval(load, 30000);
}

$("gate-form").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var e = $("gate-err"); e.textContent = "";
  var r;
  try {
    r = await fetch(API + "/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: $("pc").value })
    });
  } catch (err) { e.textContent = "Cannot reach the server."; return; }
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || !d.token) { e.textContent = d.error || "Could not sign in."; return; }
  setTok(d.token); signedIn();
});
$("signout").addEventListener("click", function (ev) { ev.preventDefault(); signOut(); });

function typing() {
  var a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

async function load(force) {
  var d = await api("/api/op/state");
  if (d && d.stages) S = d;
  $("me").textContent = (S.me && S.me.name) || "";
  // A background poll must not wipe a half-written note.
  if (typing() && !force) return;
  render();
}

/* --------------------------------------------------------------- routing */

function route() {
  var h = (location.hash || "#/today").replace(/^#\/?/, "").split("/");
  return { view: h[0] || "today", id: h[1] || "" };
}
window.addEventListener("hashchange", render);
function go(h) { location.hash = h; }

function render() {
  if ($("app").hidden) return;
  var r = route();
  document.querySelectorAll(".nav a").forEach(function (a) {
    var v = a.getAttribute("data-nav");
    a.classList.toggle("on", v === r.view || (r.view === "job" && v === "jobs") || (r.view === "client" && v === "clients"));
  });
  var unread = S.cars.reduce(function (n, c) { return n + c.unread; }, 0);
  $("pip-today").textContent = unread || "";

  var m = $("main");
  if (r.view === "board") return viewBoard(m);
  if (r.view === "jobs") return viewJobs(m);
  if (r.view === "clients") return viewClients(m);
  if (r.view === "client") return viewClient(m, r.id);
  if (r.view === "job") return viewJob(m, r.id);
  if (r.view === "settings") return viewSettings(m);
  return viewToday(m);
}

function head(title, backHref, crumb) {
  return '<div class="head">' +
    (backHref ? '<a class="back" href="' + backHref + '">&larr; Back</a>' : "") +
    "<h1>" + esc(title) + "</h1>" +
    (crumb ? '<div class="crumb">' + crumb + "</div>" : "") + "</div>";
}

/* ----------------------------------------------------------------- today */

function viewToday(m) {
  var live = 0, hold = 0, done = 0, ask = 0;
  S.cars.forEach(function (c) {
    ask += c.unread;
    if (isLast(c.stage)) { done++; return; }
    live++; if (c.hold) hold++;
  });

  var need = S.cars.filter(function (c) {
    return !isLast(c.stage) && (c.unread > 0 || c.hold || c.days >= 14);
  }).sort(function (a, b) { return (b.unread - a.unread) || (b.days - a.days); });

  var rows = need.map(function (c) {
    var why = c.unread ? c.unread + (c.unread > 1 ? " questions" : " question")
      : c.hold ? c.hold : c.days + " days in " + ((stageOf(c.stage) || {}).op_label || "");
    var cls = c.unread ? "chip bad" : c.hold ? "chip warn" : ageChip(c.days);
    var cl = clientById(c.client_id) || {};
    return '<a class="rw" href="#/job/' + c.id + '">' +
      '<span class="ava">' + esc(initials(cl.name)) + "</span>" +
      '<span class="mid"><span class="nm">' + esc(cl.name || "") + "</span>" +
      '<span class="sub">' + esc(c.description) + "</span></span>" +
      '<span class="' + cls + '">' + esc(why) + "</span>" +
      '<span class="go">&rsaquo;</span></a>';
  }).join("");

  m.innerHTML = head("Today") +
    '<div class="counts">' +
    '<button class="count" data-go="#/board"><b>' + live + '</b><span class="lbl">In progress</span></button>' +
    '<button class="count warn" data-go="#/jobs"><b>' + hold + '</b><span class="lbl">Waiting on someone</span></button>' +
    '<button class="count bad" data-go="#/jobs"><b>' + ask + '</b><span class="lbl">Unread questions</span></button>' +
    '<button class="count" data-go="#/jobs"><b>' + done + '</b><span class="lbl">Finished</span></button>' +
    "</div>" +
    '<div class="cols2"><div>' +
      '<div class="panel"><header><span class="lbl">Needs you</span></header>' +
      (rows ? '<div class="rows">' + rows + "</div>"
            : '<div class="empty">' + (S.cars.length ? "Nothing outstanding." : "No cars yet.") +
              (S.cars.length ? "" : '<br><a class="btn" href="#/job/new">Add a car</a>') + "</div>") +
      "</div></div><div>" +
      '<div class="panel"><header><span class="lbl">Recent messages out</span>' +
      '<a class="back" href="#/settings">Settings</a></header>' +
      (S.log.length ? '<div class="rows">' + S.log.slice(0, 6).map(function (l) {
        return '<div class="rw" style="cursor:default">' +
          '<span class="mid"><span class="nm">' + esc(l.recipient) + "</span>" +
          '<span class="sub">' + esc(l.body) + "</span></span>" +
          '<span class="chip ' + (l.status === "sent" ? "done" : l.status === "failed" ? "bad" : "warn") + '">' +
          (l.status === "held" ? "not sent" : esc(l.status)) + "</span></div>";
      }).join("") + "</div>" : '<div class="empty">Nothing yet.</div>') +
      "</div></div></div>";

  m.querySelectorAll("[data-go]").forEach(function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
  });
}

/* ----------------------------------------------------------------- board */

function viewBoard(m) {
  var cols = S.stages.map(function (st, si) {
    var rows = S.cars.filter(function (c) { return c.stage === st.id; });
    var cards = rows.map(function (c) {
      var cl = clientById(c.client_id) || {};
      var next = S.stages[si + 1];
      return '<div class="card">' +
        '<a class="open" href="#/job/' + c.id + '">' +
        '<span class="car">' + esc(c.description) + "</span>" +
        '<span class="who">' + esc(cl.name || "") + "</span>" +
        '<span class="chips"><span class="' + ageChip(c.days) + '">' + c.days + "d</span>" +
        (c.hold ? '<span class="chip hold">' + esc(c.hold) + "</span>" : "") +
        (c.unread ? '<span class="chip bad">' + c.unread + " new</span>" : "") +
        "</span></a>" +
        (next ? '<button class="adv" data-next="' + c.id + '" data-to="' + next.id + '">Move to ' + esc(next.op_label) + "</button>" : "") +
        "</div>";
    }).join("");
    return '<div class="col' + (si === S.stages.length - 1 ? " last" : "") + '">' +
      '<div class="col-h"><span class="lbl">' + esc(st.op_label) + '</span><span class="n">' + rows.length + "</span></div>" +
      (cards || '<div class="col-empty">&mdash;</div>') + "</div>";
  }).join("");

  m.innerHTML = head("Board") + '<div class="board"><div class="cols">' + cols + "</div></div>";
  m.querySelectorAll("[data-next]").forEach(function (b) {
    b.addEventListener("click", async function () {
      b.disabled = true;
      await moveStage(b.getAttribute("data-next"), b.getAttribute("data-to"), "");
    });
  });
}

/* ------------------------------------------------------------------ cars */

var jobQuery = "";
function jobRows() {
  var q = jobQuery.toLowerCase();
  var list = S.cars.filter(function (c) {
    if (!q) return true;
    var cl = clientById(c.client_id) || {};
    return (c.description + " " + c.chassis + " " + (cl.name || "") + " " + c.plate_no).toLowerCase().indexOf(q) > -1;
  }).sort(function (a, b) { return stageIdx(a.stage) - stageIdx(b.stage) || b.days - a.days; });

  return list;
}

function fillJobRows(m) {
  var list = jobRows();
  var body = list.map(function (c) {
    var cl = clientById(c.client_id) || {};
    var st = stageOf(c.stage) || {};
    return '<tr data-open="' + c.id + '">' +
      "<td><b>" + esc(c.description) + "</b><br><span class=\"mono\" style=\"font-size:11px;color:var(--faint)\">" + esc(c.chassis) + "</span></td>" +
      "<td>" + esc(cl.name || "") + "</td>" +
      '<td><span class="chip ' + (isLast(c.stage) ? "done" : "stage") + '">' + esc(st.op_label || "") + "</span></td>" +
      '<td class="opt"><span class="' + ageChip(c.days) + '">' + c.days + "d</span></td>" +
      '<td class="opt">' + (c.hold ? '<span class="chip warn">' + esc(c.hold) + "</span>" : "") + "</td>" +
      '<td class="opt mono" style="font-size:11.5px">' + esc(fmtDate(c.eta_ready)) + "</td>" +
      "<td>" + (c.unread ? '<span class="chip bad">' + c.unread + "</span>" : "") + "</td></tr>";
  }).join("");
  var tb = m.querySelector("tbody");
  tb.innerHTML = body || '<tr><td colspan="7"><div class="empty">No cars match.</div></td></tr>';
  tb.querySelectorAll("[data-open]").forEach(function (tr) {
    tr.addEventListener("click", function () { go("#/job/" + tr.getAttribute("data-open")); });
  });
}

function viewJobs(m) {
  m.innerHTML = head("Cars") +
    '<div class="row" style="margin-bottom:14px">' +
    '<input id="jq" type="search" placeholder="Search car, chassis, client or plate" style="max-width:320px" value="' + esc(jobQuery) + '">' +
    '<button class="btn" id="newcar">Add a car</button></div>' +
    '<div class="panel"><div class="tblwrap"><table class="tbl">' +
    "<thead><tr><th>Car</th><th>Client</th><th>Stage</th>" +
    '<th class="opt">In stage</th><th class="opt">Waiting on</th><th class="opt">Ready</th><th></th></tr></thead>' +
    "<tbody></tbody></table></div></div>";
  fillJobRows(m);

  var qi = $("jq");
  qi.addEventListener("input", function () { jobQuery = qi.value; fillJobRows(m); });
  $("newcar").addEventListener("click", function () { go("#/job/new"); });
}

/* ------------------------------------------------------------------- job */

function viewJob(m, id) {
  if (id === "new") return viewNewJob(m);
  var c = carById(id);
  if (!c) { m.innerHTML = head("Car", "#/jobs") + '<div class="empty">That car is no longer on the board.</div>'; return; }
  var cl = clientById(c.client_id) || {};
  var st = stageOf(c.stage) || {};

  var opts = S.stages.map(function (s) {
    return '<option value="' + s.id + '"' + (s.id === c.stage ? " selected" : "") + ">" + esc(s.op_label) + "</option>";
  }).join("");

  m.innerHTML = head(c.description, "#/jobs",
      '<a href="#/client/' + cl.id + '">' + esc(cl.name || "") + "</a> &middot; " +
      '<span class="mono">' + esc(c.chassis) + "</span>") +
    '<div class="cols2"><div class="stack">' +

      '<div class="panel"><header><span class="lbl">Stage</span>' +
      '<span class="chip ' + (isLast(c.stage) ? "done" : "stage") + '">' + esc(st.op_label || "") + " &middot; " + c.days + "d</span></header>" +
      '<div class="body stack">' +
        '<div class="row"><select id="j-stage" style="max-width:230px">' + opts + "</select>" +
        '<input id="j-snote" placeholder="Why (optional)" style="max-width:230px">' +
        '<button class="btn" id="j-move">Move</button></div>' +
        '<label class="field"><span>Waiting on</span><div class="row">' +
        '<input id="j-hold" value="' + esc(c.hold) + '" placeholder="Nobody, it is moving" style="flex:1;min-width:180px">' +
        '<button class="btn quiet" id="j-holdsave">Save</button></div></label>' +
      "</div></div>" +

      '<div class="panel"><header><span class="lbl">Messages</span>' +
      (c.unread ? '<span class="chip bad">' + c.unread + " unread</span>" : "") + "</header>" +
      '<div class="thread" id="j-thread"></div>' +
      '<div class="composer"><textarea id="j-msg" rows="1" placeholder="Reply to ' + esc(cl.first_name || "this client") + '"></textarea>' +
      '<button class="btn" id="j-send">Send</button></div></div>' +

      '<div class="panel"><header><span class="lbl">History</span></header>' +
      (c.history.length ? c.history.slice().reverse().map(function (e) {
        return '<div class="ev"><span class="d">' + esc(e.when) + "</span>" +
          '<span class="w">' + esc(e.what) + (e.note ? '<span class="note">' + esc(e.note) + "</span>" : "") + "</span>" +
          '<span class="by">' + esc(e.who || "") + "</span></div>";
      }).join("") : '<div class="empty">Nothing yet.</div>') + "</div>" +

    "</div><div class=\"stack\">" +

      '<div class="panel"><header><span class="lbl">Details</span></header><div class="body stack">' +
        '<label class="field"><span>Car</span><input id="j-desc" value="' + esc(c.description) + '"></label>' +
        '<label class="field"><span>Chassis</span><input id="j-chassis" class="mono" value="' + esc(c.chassis) + '"></label>' +
        '<div class="grid">' +
        '<label class="field"><span>Plate number</span><input id="j-plate" class="mono" value="' + esc(c.plate_no) + '" placeholder="once issued"></label>' +
        '<label class="field"><span>Ready by</span><input id="j-eta" type="date" value="' + esc(c.eta_ready) + '"></label>' +
        "</div>" +
        '<label class="field"><span>Workshop</span><input id="j-workshop" value="' + esc(c.workshop) + '"></label>' +
        '<label class="field"><span>Office note &mdash; the client never sees this</span>' +
        '<textarea id="j-onote" rows="3">' + esc(c.office_note) + "</textarea></label>" +
        '<div class="row"><button class="btn" id="j-save">Save</button>' +
        '<button class="btn danger sm" id="j-del">Remove car</button></div>' +
      "</div></div>" +

      '<div class="panel"><header><span class="lbl">Documents</span>' +
      '<button class="btn ghost sm" id="j-upload">Upload</button></header>' +
      '<input type="file" id="j-file" hidden>' +
      (c.docs.length ? '<div class="docs">' + c.docs.map(function (d) {
        return '<div class="doc"><span class="nm">' + esc(d.name) +
          '<br><span class="mono" style="font-size:10.5px;color:var(--faint)">' + esc(d.at) + " &middot; " + esc(d.by) + "</span></span>" +
          '<label class="toggle" title="Show this to the client"><input type="checkbox" data-vis="' + d.id + '"' +
          (d.client_visible ? " checked" : "") + '><span class="track"></span></label>' +
          '<button class="btn quiet sm" data-dl="' + d.id + '">Open</button>' +
          '<button class="btn quiet sm" data-rm="' + d.id + '">&times;</button></div>';
      }).join("") + "</div>" : '<div class="empty">No documents.</div>') + "</div>" +

    "</div></div>";

  drawThread($("j-thread"), c, cl);
  if (c.unread) api("/api/op/read", { vehicle_id: c.id }).then(function () { load(); });

  $("j-move").addEventListener("click", async function () {
    await moveStage(c.id, $("j-stage").value, $("j-snote").value);
  });
  $("j-holdsave").addEventListener("click", async function () {
    await api("/api/op/vehicle/hold", { vehicle_id: c.id, hold_reason: $("j-hold").value });
    toast($("j-hold").value ? "Saved" : "Cleared"); load(true);
  });
  $("j-save").addEventListener("click", async function () {
    var r = await api("/api/op/vehicle/save", {
      id: c.id, description: $("j-desc").value, chassis: $("j-chassis").value,
      plate_no: $("j-plate").value, eta_ready: $("j-eta").value,
      workshop: $("j-workshop").value, office_note: $("j-onote").value
    });
    toast(r && r.ok ? "Saved" : (r && r.error) || "Could not save"); load(true);
  });
  $("j-del").addEventListener("click", async function () {
    if (!confirm("Remove " + c.description + " from the board?")) return;
    await api("/api/op/vehicle/delete", { id: c.id });
    toast("Removed"); go("#/jobs"); load(true);
  });
  $("j-send").addEventListener("click", async function () {
    var t = $("j-msg").value.trim(); if (!t) return $("j-msg").focus();
    await api("/api/op/reply", { vehicle_id: c.id, body: t });
    $("j-msg").value = ""; await load(true); toast("Sent");
  });
  $("j-msg").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("j-send").click(); }
  });

  $("j-upload").addEventListener("click", function () { $("j-file").click(); });
  $("j-file").addEventListener("change", function () { uploadDoc(c.id, $("j-file").files[0]); });
  m.querySelectorAll("[data-vis]").forEach(function (cb) {
    cb.addEventListener("change", async function () {
      await api("/api/op/doc/visible", { id: cb.getAttribute("data-vis"), client_visible: cb.checked });
      toast(cb.checked ? "The client can see this" : "Hidden from the client"); load(true);
    });
  });
  m.querySelectorAll("[data-dl]").forEach(function (b) {
    b.addEventListener("click", async function () {
      var r = await api("/api/op/doc/url", { id: b.getAttribute("data-dl") });
      if (r && r.url) window.open(r.url, "_blank");
    });
  });
  m.querySelectorAll("[data-rm]").forEach(function (b) {
    b.addEventListener("click", async function () {
      if (!confirm("Delete this document?")) return;
      await api("/api/op/doc/delete", { id: b.getAttribute("data-rm") });
      toast("Deleted"); load(true);
    });
  });
}

async function uploadDoc(vid, file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return toast("That file is over 25MB.");
  toast("Uploading");
  var s = await api("/api/op/doc/sign", { vehicle_id: vid, name: file.name });
  if (!s || !s.url) return toast((s && s.error) || "Could not start the upload.");
  try {
    var put = await fetch(s.url, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    if (!put.ok) throw new Error("upload");
  } catch (e) { return toast("The upload did not finish."); }
  await api("/api/op/doc/save", {
    vehicle_id: vid, name: file.name, path: s.path,
    content_type: file.type || "", size: file.size, client_visible: false
  });
  toast("Uploaded"); load(true);
}

async function moveStage(vid, to, note) {
  var r = await api("/api/op/vehicle/stage", { vehicle_id: vid, stage_id: to, note: note || "" });
  if (!r || !r.ok) { toast((r && r.error) || "Could not move that car."); return load(true); }
  toast(r.back ? "Moved back to " + r.stage
    : r.sent ? r.stage + ", client told"
    : r.held ? r.stage + ", message not sent yet"
    : r.stage);
  load(true);
}

function drawThread(el, c, cl) {
  if (!c.messages.length) {
    el.innerHTML = '<div class="msg sys">No messages yet.</div>'; return;
  }
  el.innerHTML = c.messages.map(function (mm) {
    if (mm.from === "system") return '<div class="msg sys">' + esc(mm.body) + "</div>";
    return '<div class="msg ' + (mm.from === "office" ? "us" : "them") + '">' + esc(mm.body) +
      '<span class="meta">' + esc(mm.from === "office" ? "You" : (cl.first_name || "Client")) +
      " · " + esc(mm.at) + "</span></div>";
  }).join("");
  el.scrollTop = el.scrollHeight;
}

/* --------------------------------------------------------------- new job */

function viewNewJob(m) {
  var opts = S.clients.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + "</option>"; }).join("");
  var stages = S.stages.map(function (s) { return '<option value="' + s.id + '">' + esc(s.op_label) + "</option>"; }).join("");

  m.innerHTML = head("Add a car", "#/jobs") +
    '<div class="panel" style="max-width:620px"><div class="body stack">' +
    '<label class="field"><span>Client</span><select id="n-client"><option value="">New client</option>' + opts + "</select></label>" +
    '<div id="n-new" class="stack">' +
      '<div class="grid">' +
      '<label class="field"><span>Name</span><input id="n-name"></label>' +
      '<label class="field"><span>Company</span><input id="n-company"></label>' +
      '<label class="field"><span>Mobile</span><input id="n-phone" placeholder="+61"></label>' +
      '<label class="field"><span>Email</span><input id="n-email" type="email"></label>' +
      "</div></div>" +
    '<div class="grid">' +
    '<label class="field"><span>Car</span><input id="n-desc" placeholder="1998 Toyota Chaser"></label>' +
    '<label class="field"><span>Chassis</span><input id="n-chassis" class="mono"></label>' +
    '<label class="field"><span>Stage</span><select id="n-stage">' + stages + "</select></label>" +
    '<label class="field"><span>Workshop</span><input id="n-workshop"></label>' +
    "</div>" +
    '<div class="row"><button class="btn" id="n-go">Add car</button>' +
    '<a class="btn quiet" href="#/jobs">Cancel</a></div>' +
    '<div class="err" id="n-err"></div>' +
    "</div></div>";

  var sel = $("n-client");
  function sync() { $("n-new").style.display = sel.value ? "none" : ""; }
  sel.addEventListener("change", sync); sync();

  $("n-go").addEventListener("click", async function () {
    $("n-err").textContent = "";
    var r = await api("/api/op/vehicle/save", {
      client_id: sel.value, name: $("n-name").value, company: $("n-company").value,
      phone: $("n-phone").value, email: $("n-email").value,
      description: $("n-desc").value, chassis: $("n-chassis").value,
      workshop: $("n-workshop").value, stage: $("n-stage").value
    });
    if (!r || !r.ok) { $("n-err").textContent = (r && r.error) || "Could not add that car."; return; }
    await load(true);
    toast("Added");
    go("#/job/" + r.id);
  });
}

/* --------------------------------------------------------------- clients */

function viewClients(m) {
  var rows = S.clients.map(function (c) {
    var cars = carsOf(c.id);
    var unread = cars.reduce(function (n, x) { return n + x.unread; }, 0);
    return '<a class="rw" href="#/client/' + c.id + '">' +
      '<span class="ava">' + esc(initials(c.name)) + "</span>" +
      '<span class="mid"><span class="nm">' + esc(c.name) + "</span>" +
      '<span class="sub">' + (c.company ? esc(c.company) + " &middot; " : "") +
      cars.length + (cars.length === 1 ? " car" : " cars") + "</span></span>" +
      (unread ? '<span class="chip bad">' + unread + "</span>" : "") +
      '<span class="go">&rsaquo;</span></a>';
  }).join("");

  m.innerHTML = head("Clients") + '<div class="panel">' +
    (rows ? '<div class="rows">' + rows + "</div>" : '<div class="empty">No clients yet.</div>') + "</div>";
}

function viewClient(m, id) {
  var c = clientById(id);
  if (!c) { m.innerHTML = head("Client", "#/clients") + '<div class="empty">Not found.</div>'; return; }
  var cars = carsOf(c.id);

  m.innerHTML = head(c.name, "#/clients", esc(c.company || "")) +
    '<div class="cols2"><div class="stack">' +
      '<div class="panel"><header><span class="lbl">Cars</span>' +
      '<a class="back" href="#/job/new">Add</a></header>' +
      (cars.length ? '<div class="rows">' + cars.map(function (v) {
        var st = stageOf(v.stage) || {};
        return '<a class="rw" href="#/job/' + v.id + '">' +
          '<span class="mid"><span class="nm">' + esc(v.description) + "</span>" +
          '<span class="sub mono">' + esc(v.chassis) + "</span></span>" +
          '<span class="chip ' + (isLast(v.stage) ? "done" : "stage") + '">' + esc(st.op_label || "") + "</span>" +
          '<span class="go">&rsaquo;</span></a>';
      }).join("") + "</div>" : '<div class="empty">No cars on this client.</div>') + "</div>" +

      '<div class="panel"><header><span class="lbl">Their sign-in link</span></header><div class="body stack">' +
      '<div class="linkbox" id="c-link">&hellip;</div>' +
      '<div class="row"><button class="btn ghost" id="c-copy">Copy</button>' +
      '<button class="btn quiet" id="c-reset">Issue a new link</button></div>' +
      "</div></div>" +
    "</div><div class=\"stack\">" +
      '<div class="panel"><header><span class="lbl">Contact</span></header><div class="body stack">' +
      '<label class="field"><span>Name</span><input id="c-name" value="' + esc(c.name) + '"></label>' +
      '<label class="field"><span>Company</span><input id="c-company" value="' + esc(c.company || "") + '"></label>' +
      '<label class="field"><span>Mobile</span><input id="c-phone" value="' + esc(c.phone || "") + '"></label>' +
      '<label class="field"><span>Email</span><input id="c-email" type="email" value="' + esc(c.email || "") + '"></label>' +
      '<label class="field"><span>Office note</span><textarea id="c-note" rows="3">' + esc(c.note || "") + "</textarea></label>" +
      '<div class="row"><button class="btn" id="c-save">Save</button></div>' +
      '<p style="font-size:12px;color:var(--mute);margin:0">Updates go out by ' +
      (c.notify_sms ? "text" : "") + (c.notify_sms && c.notify_email ? " and " : "") +
      (c.notify_email ? "email" : "") + (!c.notify_sms && !c.notify_email ? "no channel, they switched both off" : "") +
      ". They set this on their own page.</p>" +
      "</div></div>" +
    "</div></div>";

  api("/api/op/link", { client_id: c.id }).then(function (r) {
    if (r && r.link) $("c-link").textContent = r.link;
  });
  $("c-copy").addEventListener("click", async function () {
    try { await navigator.clipboard.writeText($("c-link").textContent); toast("Copied"); }
    catch (e) { window.prompt("Copy this link", $("c-link").textContent); }
  });
  $("c-reset").addEventListener("click", async function () {
    if (!confirm("The old link stops working straight away. Continue?")) return;
    var r = await api("/api/op/link/reset", { client_id: c.id });
    if (r && r.link) { $("c-link").textContent = r.link; toast("New link issued"); }
  });
  $("c-save").addEventListener("click", async function () {
    var r = await api("/api/op/client/save", {
      id: c.id, name: $("c-name").value, company: $("c-company").value,
      phone: $("c-phone").value, email: $("c-email").value, note: $("c-note").value
    });
    toast(r && r.ok ? "Saved" : (r && r.error) || "Could not save"); load(true);
  });
}

/* -------------------------------------------------------------- settings */

function viewSettings(m) {
  var anyHeld = S.log.some(function (l) { return l.status === "held"; });

  var tpl = S.stages.map(function (st) {
    var t = S.templates.filter(function (x) { return x.stage_id === st.id; })[0];
    if (!t) return "";
    return '<div class="panel"><header><span class="lbl">' + esc(st.client_label) + "</span>" +
      '<label class="toggle"><input type="checkbox" data-tog="' + st.id + '"' + (t.enabled ? " checked" : "") +
      '><span class="track"></span><span>' + (t.enabled ? "on" : "off") + "</span></label></header>" +
      '<div class="body stack">' +
      '<label class="field"><span>Text message</span><textarea rows="2" data-sms="' + st.id + '">' + esc(t.sms_body) + "</textarea></label>" +
      '<label class="field"><span>Email subject</span><input data-subj="' + st.id + '" value="' + esc(t.email_subject) + '"></label>' +
      '<label class="field"><span>Email</span><textarea rows="3" data-mail="' + st.id + '">' + esc(t.email_body) + "</textarea></label>" +
      '<div class="row"><button class="btn sm" data-tsave="' + st.id + '">Save</button>' +
      '<span style="font-size:11.5px;color:var(--faint)">{name} {car} {link} are filled in when it sends</span></div>' +
      "</div></div>";
  }).join("");

  var staff = S.staff.map(function (p) {
    return '<div class="doc"><span class="nm">' + esc(p.name) +
      (p.name === S.me.name ? ' <span class="chip">you</span>' : "") + "</span>" +
      '<button class="btn quiet sm" data-staffdel="' + p.id + '">Remove</button></div>';
  }).join("");

  m.innerHTML = head("Settings") +
    (anyHeld ? '<div class="note">Texts and emails are being written down but not sent. ' +
      "Add a Resend or Twilio account in the Supabase project settings to turn sending on.</div>" : "") +
    '<div class="cols2"><div class="stack">' +
      '<h2 style="font-size:15px;margin-bottom:2px">Client updates</h2>' + tpl +
    "</div><div class=\"stack\">" +
      '<div class="panel"><header><span class="lbl">Who can sign in</span></header>' +
      '<div class="docs">' + staff + "</div>" +
      '<div class="body stack">' +
      '<div class="grid"><label class="field"><span>Name</span><input id="s-name"></label>' +
      '<label class="field"><span>Passcode</span><input id="s-pass" type="text" placeholder="8+ characters"></label></div>' +
      '<div class="row"><button class="btn" id="s-add">Add person</button></div>' +
      '<div class="err" id="s-err"></div></div></div>' +

      '<div class="panel"><header><span class="lbl">Sent messages</span></header>' +
      (S.log.length ? '<div class="rows">' + S.log.slice(0, 12).map(function (l) {
        return '<div class="rw" style="cursor:default"><span class="mid">' +
          '<span class="nm">' + esc(l.recipient) + "</span>" +
          '<span class="sub">' + esc(l.body) + "</span></span>" +
          '<span class="chip ' + (l.status === "sent" ? "done" : l.status === "failed" ? "bad" : "warn") + '">' +
          (l.status === "held" ? "not sent" : esc(l.status)) + "</span></div>";
      }).join("") + "</div>" : '<div class="empty">Nothing yet.</div>') + "</div>" +

      (S.cars.some(function (c) { return c.is_sample; })
        ? '<div class="panel"><div class="body row">' +
          '<span style="flex:1;font-size:13px">This board still has the example cars on it.</span>' +
          '<button class="btn quiet sm" id="s-clear">Remove them</button></div></div>' : "") +
    "</div></div>";

  m.querySelectorAll("[data-tog]").forEach(function (cb) {
    cb.addEventListener("change", async function () {
      await api("/api/op/template/toggle", { stage_id: cb.getAttribute("data-tog"), enabled: cb.checked });
      load(true);
    });
  });
  m.querySelectorAll("[data-tsave]").forEach(function (b) {
    b.addEventListener("click", async function () {
      var id = b.getAttribute("data-tsave");
      var r = await api("/api/op/template/save", {
        stage_id: id,
        sms_body: m.querySelector('[data-sms="' + id + '"]').value,
        email_subject: m.querySelector('[data-subj="' + id + '"]').value,
        email_body: m.querySelector('[data-mail="' + id + '"]').value
      });
      toast(r && r.ok ? "Saved" : "Could not save"); load(true);
    });
  });
  $("s-add").addEventListener("click", async function () {
    $("s-err").textContent = "";
    var r = await api("/api/op/staff/save", { name: $("s-name").value, passcode: $("s-pass").value });
    if (!r || !r.ok) { $("s-err").textContent = (r && r.error) || "Could not add."; return; }
    $("s-name").value = ""; $("s-pass").value = ""; toast("Added"); load(true);
  });
  m.querySelectorAll("[data-staffdel]").forEach(function (b) {
    b.addEventListener("click", async function () {
      if (!confirm("Remove this sign-in?")) return;
      var r = await api("/api/op/staff/delete", { id: b.getAttribute("data-staffdel") });
      if (r && r.error) return toast(r.error);
      toast("Removed"); load(true);
    });
  });
  if ($("s-clear")) $("s-clear").addEventListener("click", async function () {
    if (!confirm("Remove the example cars and their clients?")) return;
    await api("/api/op/clear_samples", {}); toast("Removed"); load(true);
  });
}

/* ------------------------------------------------------------------ boot */

if (tok()) signedIn(); else $("gate").hidden = false;

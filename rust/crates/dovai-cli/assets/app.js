"use strict";

const $ = (id) => document.getElementById(id);

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  },
  async post(path, data) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`${path}: HTTP ${r.status} ${text}`);
    }
    return r.json().catch(() => ({}));
  },
};

function fmtNum(n) {
  if (n == null) return "\u2014";
  if (n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtUsd(v) {
  if (v == null) return "\u2014";
  if (v === 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  if (v < 1000) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toLocaleString();
}

function setStatus(msg, kind) {
  const el = $("save-status");
  el.textContent = msg;
  el.className = "status-msg" + (kind ? " " + kind : "");
}

// ---- Provider + routing state ----

let providers = {
  anthropic: { api_key: "" },
  xai: { api_key: "" },
  openai: { api_key: "" },
  local: { endpoint: "" },
};
let availableModels = []; // ModelGroup[] from server
let routing = {
  pm: { name: "", model: "" },
  simple: { name: "", model: "" },
  complex: { name: "", model: "" },
  clerk: { name: "", model: "" },
};

function syncProvidersFromDom() {
  providers.anthropic.api_key = $("prov-anthropic-key").value || "";
  providers.xai.api_key = $("prov-xai-key").value || "";
  providers.openai.api_key = $("prov-openai-key").value || "";
  providers.local = { endpoint: $("prov-local-endpoint").value || "" };
}

// Normalize routing from server — handles both old string format and new object format
function normalizeRouting(r) {
  var keys = ["pm", "simple", "complex", "clerk"];
  var out = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = r[k];
    if (typeof v === "string") {
      out[k] = { name: "", model: v };
    } else if (v && typeof v === "object") {
      out[k] = { name: v.name || "", model: v.model || "" };
    } else {
      out[k] = { name: "", model: "" };
    }
  }
  return out;
}

// ---- Routing dropdowns ----

function updateRoutingDropdowns() {
  for (const routeId of ["route-pm", "route-simple", "route-complex", "route-clerk"]) {
    const sel = $(routeId);
    if (!sel) continue;
    const key = routeId.replace("route-", "");
    const current = sel.value || routing[key].model;
    sel.innerHTML = '<option value="">\u2014 Select \u2014</option>';
    // Populate from available models, grouped by provider
    for (const group of availableModels) {
      if (!group.available || group.models.length === 0) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.provider;
      for (const m of group.models) {
        const opt = document.createElement("option");
        opt.value = group.provider_type + ":" + m.id;
        opt.textContent = group.provider + " \u2014 " + m.label;
        if (opt.value === current) opt.selected = true;
        optgroup.appendChild(opt);
      }
      sel.appendChild(optgroup);
    }
    // If current value not matched (e.g. custom model), add it
    if (current && !sel.value) {
      const opt = document.createElement("option");
      opt.value = current;
      opt.textContent = current + " (current)";
      opt.selected = true;
      sel.prepend(opt);
    }
  }
}

// ---- Model fetching for routing dropdowns ----

async function refreshAvailableModels() {
  syncProvidersFromDom();

  const statusEls = document.querySelectorAll(".route-model-status");
  statusEls.forEach(function (el) { el.textContent = "Fetching models\u2026"; el.className = "help route-model-status"; });

  var providerConfigs = [
    { type: "anthropic", name: "Anthropic", key: providers.anthropic.api_key || "" },
    { type: "xai", name: "xAI", key: providers.xai.api_key || "" },
    { type: "openai", name: "OpenAI", key: providers.openai.api_key || "" },
    { type: "local", name: "Local", endpoint: (providers.local && providers.local.endpoint) || "" },
  ];

  var results = await Promise.all(providerConfigs.map(async function (pc) {
    var hasAuth = pc.type === "local" ? pc.endpoint : pc.key;
    if (!hasAuth) return { type: pc.type, name: pc.name, models: [], available: false };
    try {
      var r = await api.post("/api/models", {
        provider: pc.type,
        api_key: pc.key || "",
        endpoint: pc.endpoint || "",
      });
      return { type: pc.type, name: pc.name, models: r.ok ? r.models : [], available: true };
    } catch (e) {
      return { type: pc.type, name: pc.name, models: [], available: false };
    }
  }));

  availableModels = results
    .filter(function (r) { return r.available && r.models.length > 0; })
    .map(function (r) { return { provider: r.name, provider_type: r.type, available: true, models: r.models }; });

  updateRoutingDropdowns();

  var total = availableModels.reduce(function (sum, g) { return sum + g.models.length; }, 0);
  statusEls.forEach(function (el) {
    el.textContent = total + " models available";
    el.className = "help route-model-status status-success";
  });
  setTimeout(function () { statusEls.forEach(function (el) { el.textContent = ""; }); }, 4000);
}

// ---- Event delegation ----

document.addEventListener("click", (e) => {
  // Reveal/hide password
  if (e.target.classList.contains("reveal")) {
    const input = e.target.closest(".input-with-reveal").querySelector("input");
    if (input.type === "password") {
      input.type = "text";
      e.target.textContent = "Hide";
    } else {
      input.type = "password";
      e.target.textContent = "Show";
    }
    return;
  }
  // Fetch models for routing dropdowns
  if (e.target.classList.contains("btn-fetch-routing-models")) {
    refreshAvailableModels();
    return;
  }
});

// ---- Helpers ----

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function escAttr(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Load ----

async function loadAll() {
  try {
    const [config, usage] = await Promise.all([
      api.get("/api/config"),
      api.get("/api/usage").catch((e) => {
        console.warn("usage load failed:", e);
        return null;
      }),
    ]);

    // Workspace indicator
    if (config.workspace) {
      $("workspace-dot").classList.add("active");
      $("workspace-label").textContent = "Workspace: " + config.workspace.label;
    } else {
      $("workspace-label").textContent = "No workspace";
    }

    // Load providers
    if (config.providers) {
      providers = {
        anthropic: config.providers.anthropic || { api_key: "" },
        xai: config.providers.xai || { api_key: "" },
        openai: config.providers.openai || { api_key: "" },
        local: config.providers.local || { endpoint: "" },
      };
    }
    $("prov-anthropic-key").value = providers.anthropic.api_key || "";
    $("prov-xai-key").value = providers.xai.api_key || "";
    $("prov-openai-key").value = providers.openai.api_key || "";
    $("prov-local-endpoint").value = (providers.local && providers.local.endpoint) || "";

    // Store available models for routing dropdowns
    availableModels = config.available_models || [];

    // Load routing (handles both old string format and new object format)
    routing = normalizeRouting(config.routing || {});

    // Set name inputs
    $("route-pm-name").value = routing.pm.name || "";
    $("route-simple-name").value = routing.simple.name || "";
    $("route-complex-name").value = routing.complex.name || "";
    $("route-clerk-name").value = routing.clerk.name || "";

    updateRoutingDropdowns();

    // Identity
    if (config.workspace) {
      $("identity-card").hidden = false;
      $("agent-name").value = config.workspace.agent_display_name || "";
      $("agent-email").value = config.workspace.agent_email || "";
      $("owner-name").value = config.workspace.owner_name || "";

      // Owner profile
      $("owner-card").hidden = false;
      $("owner-profile").value = config.owner_profile || "";
    }

    // Usage
    if (usage) {
      $("total-tokens").textContent = fmtNum(usage.total_tokens);
      $("input-tokens").textContent = fmtNum(usage.input_tokens);
      $("output-tokens").textContent = fmtNum(usage.output_tokens);
      $("est-cost").textContent = fmtUsd(usage.estimated_cost_usd);
      $("usage-sessions").textContent = fmtNum(usage.sessions_scanned);

      // Period breakdown
      const periodsEl = $("usage-periods");
      periodsEl.innerHTML = "";
      if (usage.periods && usage.periods.length > 0) {
        for (const p of usage.periods) {
          const div = document.createElement("div");
          div.className = "usage-period";
          div.innerHTML =
            '<span class="period-label">' + escHtml(p.label) + "</span>" +
            '<span class="period-cost">' + escHtml(fmtUsd(p.estimated_cost_usd)) + "</span>" +
            '<span class="period-detail">' + escHtml(fmtNum(p.total_tokens)) + " tokens \u00b7 " + escHtml(String(p.sessions)) + " sessions</span>";
          periodsEl.appendChild(div);
        }
      }

      // Provider breakdown
      const providersEl = $("usage-providers");
      providersEl.innerHTML = "";
      if (usage.providers && usage.providers.length > 0) {
        for (const p of usage.providers) {
          const row = document.createElement("div");
          row.className = "provider-row";
          const detailParts = [];
          if (p.input_tokens) detailParts.push(escHtml(fmtNum(p.input_tokens)) + " in");
          if (p.output_tokens) detailParts.push(escHtml(fmtNum(p.output_tokens)) + " out");
          if (p.cache_read_tokens) detailParts.push(escHtml(fmtNum(p.cache_read_tokens)) + " cached");
          const detail = detailParts.length > 0 ? detailParts.join(" \u00b7 ") : escHtml(fmtNum(p.total_tokens)) + " tokens";
          row.innerHTML =
            '<div class="provider-header">' +
              '<span class="provider-name">' + escHtml(p.provider) + "</span>" +
              '<span class="provider-model">' + escHtml(p.model) + "</span>" +
              '<span class="provider-cost">' + escHtml(fmtUsd(p.estimated_cost_usd)) + "</span>" +
            "</div>" +
            '<div class="provider-detail">' + detail + "</div>";
          providersEl.appendChild(row);
        }
      } else {
        providersEl.innerHTML = '<p class="no-provider-data">No provider data yet</p>';
      }
    }
  } catch (e) {
    setStatus("Failed to load: " + e.message, "error");
  }
}

// ---- Save ----

async function saveAll() {
  const btn = $("save-btn");
  btn.disabled = true;
  setStatus("Saving\u2026");

  try {
    syncProvidersFromDom();

    const body = {
      providers: providers,
      routing: {
        pm: { name: $("route-pm-name").value.trim(), model: $("route-pm").value },
        simple: { name: $("route-simple-name").value.trim(), model: $("route-simple").value },
        complex: { name: $("route-complex-name").value.trim(), model: $("route-complex").value },
        clerk: { name: $("route-clerk-name").value.trim(), model: $("route-clerk").value },
      },
    };
    if (!$("identity-card").hidden) {
      body.workspace = {
        agent_display_name: $("agent-name").value.trim(),
        agent_email: $("agent-email").value.trim(),
        owner_name: $("owner-name").value.trim(),
      };
    }
    if (!$("owner-card").hidden) {
      body.owner_profile = $("owner-profile").value;
    }
    await api.post("/api/config", body);
    setStatus("\u2713 Saved \u2014 changes take effect on next turn", "success");
    setTimeout(() => setStatus(""), 6000);
  } catch (e) {
    setStatus("\u2717 " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---- Save button + Cmd-S ----
$("save-btn").addEventListener("click", saveAll);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    saveAll();
  }
});

// ===========================================================================
// SERVICES
// ===========================================================================

var SERVICE_LABELS = {
  "cron-scheduler": "Scheduler",
  "telegram-bot": "Telegram Bot",
  "email-poller": "Email Poller",
  "filing-clerk": "Filing Clerk",
  "inbox-watcher": "Inbox Watcher",
  "task-poller": "Task Poller",
};

function timeAgo(isoStr) {
  if (!isoStr) return "";
  try {
    var then = new Date(isoStr).getTime();
    var now = Date.now();
    var sec = Math.floor((now - then) / 1000);
    if (sec < 0) return "just now";
    if (sec < 60) return sec + "s ago";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + " min ago";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + "h ago";
    return Math.floor(hr / 24) + "d ago";
  } catch (e) { return ""; }
}

function isStaleHeartbeat(isoStr) {
  if (!isoStr) return false;
  try {
    return (Date.now() - new Date(isoStr).getTime()) > 3 * 60 * 1000; // >3 min
  } catch (e) { return false; }
}

function renderServices(services) {
  var list = $("services-list");
  if (!services || services.length === 0) {
    list.innerHTML = '<p class="muted">No services found (no workspace detected)</p>';
    $("services-card").hidden = true;
    return;
  }
  $("services-card").hidden = false;
  list.innerHTML = "";
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var label = SERVICE_LABELS[s.name] || s.name;
    var row = document.createElement("div");
    row.className = "service-row";

    var ago = timeAgo(s.last_active);
    var stale = s.running && isStaleHeartbeat(s.last_active);
    var activeHtml = "";
    if (ago) {
      var cls = stale ? "service-active stale" : "service-active";
      activeHtml = '<span class="' + cls + '">' + (stale ? "unresponsive · " : "active ") + escHtml(ago) + '</span>';
    }

    row.innerHTML =
      '<span class="service-indicator ' + (s.running ? (stale ? "stale" : "running") : "stopped") + '"></span>' +
      '<span class="service-name">' + escHtml(label) + '</span>' +
      '<span class="service-state">' + escHtml(s.state) + '</span>' +
      activeHtml +
      '<button type="button" class="service-restart-btn" data-svc="' + escHtml(s.name) + '">' +
        (s.running ? "Restart" : "Start") +
      '</button>';
    list.appendChild(row);
  }
}

async function loadServices() {
  try {
    var data = await api.get("/api/services");
    renderServices(data.services);
  } catch (e) {
    console.warn("services load failed:", e);
  }
}

function showServiceStatus(msg, kind) {
  var el = $("services-status");
  el.textContent = msg;
  el.className = "services-status " + (kind || "info");
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.hidden = true; }, 5000);
}

async function restartService(name) {
  showServiceStatus(name ? "Restarting " + (SERVICE_LABELS[name] || name) + "…" : "Restarting services…", "info");
  try {
    var body = name ? { name: name } : {};
    var data = await api.post("/api/services", body);
    renderServices(data.services);
    if (data.errors && data.errors.length > 0) {
      showServiceStatus("Failed: " + data.errors.join(", "), "error");
    } else if (data.restarted && data.restarted.length > 0) {
      var labels = data.restarted.map(function (n) { return SERVICE_LABELS[n] || n; });
      showServiceStatus("Restarted: " + labels.join(", "), "success");
    } else {
      showServiceStatus("All services are already running.", "success");
    }
  } catch (e) {
    showServiceStatus("Restart failed: " + e.message, "error");
  }
}

$("services-list").addEventListener("click", function (e) {
  var btn = e.target.closest(".service-restart-btn");
  if (btn) restartService(btn.dataset.svc);
});

$("btn-restart-all").addEventListener("click", function () {
  restartService(null);
});

// Load services on page load
loadServices();

var isFirstRun = new URLSearchParams(window.location.search).get("firstrun") === "1";

// Show first-run banner immediately if applicable
if (isFirstRun) {
  var banner = $("firstrun-banner");
  if (banner) banner.hidden = false;
}

loadAll().then(function () {
  // After config loads, scroll to providers card in first-run mode
  if (isFirstRun) {
    var card = $("providers-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}).catch(function () {});

// ===========================================================================
// TAB NAVIGATION
// ===========================================================================

const pages = ["settings", "tasks", "processes"];

function switchPage(page) {
  for (const p of pages) {
    const el = document.getElementById("page-" + p);
    if (el) el.hidden = (p !== page);
  }
  document.querySelectorAll(".tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.page === page);
  });
  // Show/hide footer save button (only on settings page)
  var footer = document.querySelector("footer");
  if (footer) footer.style.display = (page === "settings") ? "" : "none";

  if (page === "tasks") loadTasks();
  if (page === "processes") loadProcesses();
}

document.getElementById("tab-bar").addEventListener("click", function (e) {
  var tab = e.target.closest(".tab");
  if (tab && tab.dataset.page) switchPage(tab.dataset.page);
});

// ===========================================================================
// TASKS PAGE
// ===========================================================================

var tasksCache = [];

async function loadTasks() {
  var status = $("filter-status").value;
  var type = $("filter-type").value;
  var assigned = $("filter-assigned").value;
  var qs = [];
  if (status) qs.push("status=" + encodeURIComponent(status));
  if (type) qs.push("type=" + encodeURIComponent(type));
  if (assigned) qs.push("assigned_to=" + encodeURIComponent(assigned));
  var url = "/api/tasks" + (qs.length ? "?" + qs.join("&") : "");
  try {
    var data = await api.get(url);
    tasksCache = data.tasks || [];
    renderTaskList();
  } catch (e) {
    $("task-list").innerHTML = '<div class="task-empty">Failed to load tasks: ' + escHtml(e.message) + '</div>';
  }
}

function renderTaskList() {
  var el = $("task-list");
  if (!tasksCache.length) {
    el.innerHTML = '<div class="task-empty">No tasks match these filters</div>';
    return;
  }
  el.innerHTML = tasksCache.map(function (t) {
    var badgeClass = "badge-" + (t.type || "task");
    var priorityClass = "priority-" + (t.priority || "normal");
    var statusClass = "status-" + (t.status || "pending").replace(/ /g, "_");
    var dueStr = t.due_at ? formatDue(t.due_at) : "";
    var doneClass = (t.status === "done" || t.status === "skipped") ? " done" : "";
    return '<div class="task-row' + doneClass + '" data-id="' + t.id + '">' +
      '<span class="task-priority-dot ' + priorityClass + '"></span>' +
      '<span class="task-badge ' + badgeClass + '">' + escHtml(t.type || "task") + '</span>' +
      '<span class="task-title">' + escHtml(t.title) + '</span>' +
      (dueStr ? '<span class="task-meta">' + escHtml(dueStr) + '</span>' : '') +
      '<span class="task-status-chip ' + statusClass + '">' + escHtml((t.status || "pending").replace(/_/g, " ")) + '</span>' +
      '</div>';
  }).join("");
}

function formatDue(s) {
  if (!s) return "";
  try {
    var d = new Date(s.replace(" ", "T"));
    if (isNaN(d.getTime())) return s;
    var now = new Date();
    var diff = (d - now) / 86400000;
    var dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (d.getHours() || d.getMinutes()) {
      dateStr += " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    if (diff < 0 && diff > -1) return "Today";
    if (diff < -1) return dateStr + " (overdue)";
    return dateStr;
  } catch (_) { return s; }
}

// Task list click -> edit
$("task-list").addEventListener("click", function (e) {
  var row = e.target.closest(".task-row");
  if (!row) return;
  var id = parseInt(row.dataset.id, 10);
  var task = tasksCache.find(function (t) { return t.id === id; });
  if (task) openTaskForm(task);
});

// Filters
["filter-status", "filter-type", "filter-assigned"].forEach(function (id) {
  $(id).addEventListener("change", loadTasks);
});

// New task
$("btn-new-task").addEventListener("click", function () { openTaskForm(null); });

function openTaskForm(task) {
  $("task-edit-id").value = task ? task.id : "";
  $("task-modal-title").textContent = task ? "Edit task" : "New task";
  $("task-title").value = task ? (task.title || "") : "";
  $("task-description").value = task ? (task.description || "") : "";
  $("task-type").value = task ? (task.type || "task") : "task";
  $("task-priority").value = task ? (task.priority || "normal") : "normal";
  $("task-assigned").value = task ? (task.assigned_to || "agent") : "agent";
  $("task-status-edit").value = task ? (task.status || "pending") : "pending";
  $("task-notes").value = task ? (task.output_notes || "") : "";

  // Handle due_at
  if (task && task.due_at) {
    var dt = task.due_at.replace(" ", "T");
    if (dt.length === 19) dt = dt.slice(0, 16); // remove seconds for datetime-local
    $("task-due").value = dt;
  } else {
    $("task-due").value = "";
  }

  $("task-list").parentElement.hidden = true;
  $("task-form").hidden = false;
  $("task-title").focus();
}

function closeTaskForm() {
  $("task-form").hidden = true;
  $("task-list").parentElement.hidden = false;
}

$("task-modal-close").addEventListener("click", closeTaskForm);
$("task-modal-cancel").addEventListener("click", closeTaskForm);

// PUT / DELETE helpers
var apiPut = async function (path, data) {
  var r = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    var text = await r.text().catch(function () { return ""; });
    throw new Error(path + ": HTTP " + r.status + " " + text);
  }
  return r.json().catch(function () { return {}; });
};

var apiDelete = async function (path) {
  var r = await fetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error(path + ": HTTP " + r.status);
  return r.json().catch(function () { return {}; });
};

$("task-modal-save").addEventListener("click", async function () {
  var id = $("task-edit-id").value;
  var title = $("task-title").value.trim();
  if (!title) { alert("Title is required"); return; }

  var dueVal = $("task-due").value;
  var dueAt = dueVal ? dueVal.replace("T", " ") + (dueVal.length <= 16 ? ":00" : "") : null;

  var body = {
    title: title,
    description: $("task-description").value.trim() || null,
    type: $("task-type").value,
    priority: $("task-priority").value,
    assigned_to: $("task-assigned").value.trim() || "agent",
    status: $("task-status-edit").value,
    due_at: dueAt,
    output_notes: $("task-notes").value.trim() || null,
  };

  try {
    if (id) {
      await apiPut("/api/tasks/" + id, body);
    } else {
      await api.post("/api/tasks", body);
    }
    closeTaskForm();
    loadTasks();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// ===========================================================================
// PROCESSES PAGE
// ===========================================================================

var processesCache = [];
var currentProcess = null;
var currentSteps = [];
var currentFeedback = [];

async function loadProcesses() {
  try {
    var data = await api.get("/api/processes");
    processesCache = data.processes || [];
    renderProcessList();
  } catch (e) {
    $("process-list").innerHTML = '<div class="task-empty">Failed to load: ' + escHtml(e.message) + '</div>';
  }
}

function renderProcessList() {
  var el = $("process-list");
  if (!processesCache.length) {
    el.innerHTML = '<div class="task-empty">No processes yet. Create one to get started.</div>';
    return;
  }
  el.innerHTML = processesCache.map(function (p) {
    return '<div class="process-row" data-id="' + p.id + '">' +
      '<span class="process-name">' + escHtml(p.name) + '</span>' +
      (p.category ? '<span class="process-category">' + escHtml(p.category) + '</span>' : '') +
      '<span class="process-trigger">' + escHtml(p.trigger_type || "manual") + '</span>' +
      '</div>';
  }).join("");
}

// Process list click -> open editor
$("process-list").addEventListener("click", function (e) {
  var row = e.target.closest(".process-row");
  if (!row) return;
  openProcessEditor(parseInt(row.dataset.id, 10));
});

// New process
$("btn-new-process").addEventListener("click", async function () {
  var name = prompt("Process name:");
  if (!name || !name.trim()) return;
  try {
    var data = await api.post("/api/processes", { name: name.trim() });
    if (data.process) openProcessEditor(data.process.id);
    else loadProcesses();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

async function openProcessEditor(id) {
  try {
    var data = await api.get("/api/processes/" + id);
    currentProcess = data.process;
    currentSteps = data.steps || [];
    currentFeedback = data.feedback || [];
  } catch (e) {
    alert("Error: " + e.message);
    return;
  }

  $("process-list-view").hidden = true;
  $("process-editor").hidden = false;

  $("proc-editor-title").textContent = currentProcess.name;
  $("proc-editor-sub").textContent = "ID: " + currentProcess.id;
  $("proc-name").value = currentProcess.name || "";
  $("proc-description").value = currentProcess.description || "";
  $("proc-category").value = currentProcess.category || "";
  $("proc-trigger").value = currentProcess.trigger_type || "manual";

  renderSteps();
  renderFeedback();
  populateFeedbackStepSelect();
}

$("btn-back-to-list").addEventListener("click", function () {
  $("process-editor").hidden = true;
  $("process-list-view").hidden = false;
  currentProcess = null;
  loadProcesses();
});

// Save process details
$("btn-save-process").addEventListener("click", async function () {
  if (!currentProcess) return;
  try {
    await apiPut("/api/processes/" + currentProcess.id, {
      name: $("proc-name").value.trim(),
      description: $("proc-description").value.trim(),
      category: $("proc-category").value.trim(),
      trigger_type: $("proc-trigger").value,
    });
    $("proc-editor-title").textContent = $("proc-name").value.trim();
    setStatus("Process saved", "success");
    setTimeout(function () { setStatus(""); }, 3000);
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// ---- Steps ----

function renderSteps() {
  var el = $("step-list");
  if (!currentSteps.length) {
    el.innerHTML = '<div class="task-empty">No steps yet</div>';
    return;
  }
  el.innerHTML = currentSteps.map(function (s, i) {
    var meta = [];
    if (s.offset_days != null) meta.push((s.offset_days >= 0 ? "+" : "") + s.offset_days + " days");
    if (s.assigned_to && s.assigned_to !== "agent") meta.push(s.assigned_to);
    if (s.needs_approval) meta.push("needs approval");
    return '<div class="step-card" draggable="true" data-id="' + s.id + '" data-idx="' + i + '">' +
      '<span class="step-handle">\u2261</span>' +
      '<span class="step-num">' + (i + 1) + '</span>' +
      '<div class="step-info">' +
        '<div class="step-info-title">' + escHtml(s.title) + '</div>' +
        (meta.length ? '<div class="step-info-meta">' + escHtml(meta.join(" \u00b7 ")) + '</div>' : '') +
      '</div>' +
      '<div class="step-actions">' +
        '<button class="btn-sm btn-secondary step-edit-btn" data-id="' + s.id + '">Edit</button>' +
        '<button class="btn-danger step-delete-btn" data-id="' + s.id + '">\u00d7</button>' +
      '</div>' +
    '</div>';
  }).join("");

  // Attach drag handlers
  setupStepDrag();
}

// Step click handlers (edit / delete)
$("step-list").addEventListener("click", function (e) {
  var editBtn = e.target.closest(".step-edit-btn");
  if (editBtn) {
    var id = parseInt(editBtn.dataset.id, 10);
    var step = currentSteps.find(function (s) { return s.id === id; });
    if (step) openStepForm(step);
    return;
  }
  var deleteBtn = e.target.closest(".step-delete-btn");
  if (deleteBtn) {
    if (!confirm("Delete this step?")) return;
    var sid = parseInt(deleteBtn.dataset.id, 10);
    apiDelete("/api/process-steps/" + sid).then(function () {
      currentSteps = currentSteps.filter(function (s) { return s.id !== sid; });
      renderSteps();
      populateFeedbackStepSelect();
    }).catch(function (e) { alert("Error: " + e.message); });
    return;
  }
});

// Add step
$("btn-add-step").addEventListener("click", function () {
  openStepForm(null);
});

function openStepForm(step) {
  $("step-edit-id").value = step ? step.id : "";
  $("step-modal-title").textContent = step ? "Edit step" : "New step";
  $("step-title").value = step ? (step.title || "") : "";
  $("step-description").value = step ? (step.description || "") : "";
  $("step-offset").value = step && step.offset_days != null ? step.offset_days : "";
  $("step-assigned").value = step ? (step.assigned_to || "agent") : "agent";
  $("step-approval").checked = step ? !!step.needs_approval : false;
  $("process-editor").hidden = true;
  $("step-form").hidden = false;
  $("step-title").focus();
}

function closeStepForm() {
  $("step-form").hidden = true;
  $("process-editor").hidden = false;
}
$("step-modal-close").addEventListener("click", closeStepForm);
$("step-modal-cancel").addEventListener("click", closeStepForm);

$("step-modal-save").addEventListener("click", async function () {
  if (!currentProcess) return;
  var id = $("step-edit-id").value;
  var title = $("step-title").value.trim();
  if (!title) { alert("Title is required"); return; }

  var offsetVal = $("step-offset").value.trim();
  var body = {
    title: title,
    description: $("step-description").value.trim() || null,
    offset_days: offsetVal !== "" ? parseInt(offsetVal, 10) : null,
    assigned_to: $("step-assigned").value.trim() || "agent",
    needs_approval: $("step-approval").checked,
  };

  try {
    if (id) {
      await apiPut("/api/process-steps/" + id, body);
    } else {
      await api.post("/api/processes/" + currentProcess.id + "/steps", body);
    }
    // Reload process
    var data = await api.get("/api/processes/" + currentProcess.id);
    currentSteps = data.steps || [];
    renderSteps();
    populateFeedbackStepSelect();
    closeStepForm();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// ---- Drag and drop for steps ----

function setupStepDrag() {
  var cards = document.querySelectorAll(".step-card");
  var dragSrc = null;

  cards.forEach(function (card) {
    card.addEventListener("dragstart", function (e) {
      dragSrc = card;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.idx);
    });
    card.addEventListener("dragend", function () {
      card.classList.remove("dragging");
      dragSrc = null;
    });
    card.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    card.addEventListener("drop", async function (e) {
      e.preventDefault();
      if (!dragSrc || dragSrc === card) return;
      var fromIdx = parseInt(dragSrc.dataset.idx, 10);
      var toIdx = parseInt(card.dataset.idx, 10);
      // Reorder in memory
      var moved = currentSteps.splice(fromIdx, 1)[0];
      currentSteps.splice(toIdx, 0, moved);
      // Send reorder to server
      var stepIds = currentSteps.map(function (s) { return s.id; });
      try {
        await api.post("/api/processes/" + currentProcess.id + "/steps/reorder", { step_ids: stepIds });
        renderSteps();
      } catch (err) {
        alert("Reorder failed: " + err.message);
        // Reload to fix state
        var data = await api.get("/api/processes/" + currentProcess.id);
        currentSteps = data.steps || [];
        renderSteps();
      }
    });
  });
}

// ---- Feedback ----

function renderFeedback() {
  var el = $("feedback-list");
  if (!currentFeedback.length) {
    el.innerHTML = '<div class="task-empty" style="padding:8px;">No feedback yet</div>';
    return;
  }
  el.innerHTML = currentFeedback.map(function (f) {
    var stepLabel = f.step_id ? "Step " + getStepLabel(f.step_id) : "General";
    return '<div class="feedback-item">' +
      '<span class="fb-text">' + escHtml(f.feedback_text) + '</span>' +
      '<span class="fb-meta">' + escHtml(stepLabel) + ' \u00b7 ' + escHtml(f.created_at || "") + '</span>' +
      '<button class="btn-danger fb-delete" data-id="' + f.id + '" style="margin-left:4px;">\u00d7</button>' +
    '</div>';
  }).join("");
}

function getStepLabel(stepId) {
  for (var i = 0; i < currentSteps.length; i++) {
    if (currentSteps[i].id === stepId) return (i + 1) + ". " + currentSteps[i].title;
  }
  return "#" + stepId;
}

function populateFeedbackStepSelect() {
  var sel = $("feedback-step-select");
  sel.innerHTML = '<option value="">General</option>';
  currentSteps.forEach(function (s, i) {
    var opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = (i + 1) + ". " + s.title;
    sel.appendChild(opt);
  });
}

$("btn-add-feedback").addEventListener("click", async function () {
  if (!currentProcess) return;
  var text = $("feedback-text").value.trim();
  if (!text) return;
  var stepId = $("feedback-step-select").value || null;
  try {
    await api.post("/api/processes/" + currentProcess.id + "/feedback", {
      step_id: stepId ? parseInt(stepId, 10) : null,
      feedback_text: text,
    });
    $("feedback-text").value = "";
    var data = await api.get("/api/processes/" + currentProcess.id);
    currentFeedback = data.feedback || [];
    renderFeedback();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// Delete feedback
$("feedback-list").addEventListener("click", async function (e) {
  var btn = e.target.closest(".fb-delete");
  if (!btn) return;
  var id = parseInt(btn.dataset.id, 10);
  try {
    await apiDelete("/api/process-feedback/" + id);
    currentFeedback = currentFeedback.filter(function (f) { return f.id !== id; });
    renderFeedback();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// ---- Activate process ----

$("btn-activate-process").addEventListener("click", function () {
  if (!currentProcess || !currentSteps.length) {
    alert("Add steps before activating");
    return;
  }
  // Default to today
  var today = new Date().toISOString().slice(0, 10);
  $("activate-date").value = today;
  $("activate-title").value = "";
  updateActivatePreview();
  $("process-editor").hidden = true;
  $("activate-form").hidden = false;
});

$("activate-date").addEventListener("change", updateActivatePreview);

function updateActivatePreview() {
  var dateStr = $("activate-date").value;
  if (!dateStr) { $("activate-preview").innerHTML = ""; return; }
  var ref = new Date(dateStr + "T00:00:00");
  var html = '<table><thead><tr><th>#</th><th>Step</th><th>Due</th><th>Assigned</th></tr></thead><tbody>';
  currentSteps.forEach(function (s, i) {
    var due = "—";
    if (s.offset_days != null) {
      var d = new Date(ref);
      d.setDate(d.getDate() + s.offset_days);
      due = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
    html += '<tr><td>' + (i + 1) + '</td><td>' + escHtml(s.title) + '</td><td>' + escHtml(due) + '</td><td>' + escHtml(s.assigned_to || "agent") + '</td></tr>';
  });
  html += '</tbody></table>';
  $("activate-preview").innerHTML = html;
}

$("activate-modal-cancel").addEventListener("click", function () {
  $("activate-form").hidden = true;
  $("process-editor").hidden = false;
});

$("activate-modal-confirm").addEventListener("click", async function () {
  if (!currentProcess) return;
  var dateStr = $("activate-date").value;
  if (!dateStr) { alert("Select a reference date"); return; }
  try {
    var result = await api.post("/api/processes/" + currentProcess.id + "/activate", {
      reference_date: dateStr,
      parent_title: $("activate-title").value.trim() || null,
    });
    $("activate-form").hidden = true;
    $("process-editor").hidden = false;
    alert("Created " + result.tasks_created + " task(s). Switch to the Tasks tab to see them.");
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// Escape key closes open inline forms
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    if (!$("activate-form").hidden) {
      $("activate-form").hidden = true;
      $("process-editor").hidden = false;
      return;
    }
    if (!$("step-form").hidden) {
      closeStepForm();
      return;
    }
    if (!$("task-form").hidden) {
      closeTaskForm();
      return;
    }
  }
});

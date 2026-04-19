/*
 * Dovai web UI — vanilla JS single-page app.
 *
 * No build step. All logic talks to /api/* endpoints. Designed to work
 * fine on a phone over LAN.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ------ domain filter state ------
let selectedDomain = ""; // "" means all domains
let knownDomains = [];   // cached from /api/domains

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && data.error) || r.statusText;
    throw new Error(`${method} ${path} → ${r.status}: ${msg}`);
  }
  return data;
}

// ------ tabs ------
function initTabs() {
  $$("#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Clean up domain-page timers when leaving that view
      clearSmartFoldersTimer();
      $$("#tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $$(".tab").forEach((t) => t.classList.remove("active"));
      const target = document.getElementById(`tab-${tab}`);
      if (target) target.classList.add("active");
      onTabShown(tab);
    });
  });
}

// ------ domain filter ------
$("#domain-filter")?.addEventListener("change", (e) => {
  selectedDomain = e.target.value;
  // Reload current tab's data with new filter
  const active = $(".tabs button.active");
  if (active) onTabShown(active.dataset.tab);
});

async function loadDomains() {
  try {
    knownDomains = await api("GET", "/api/domains");
    const sel = $("#domain-filter");
    // Preserve current selection
    const prev = sel.value;
    sel.innerHTML = '<option value="">All domains</option>';
    knownDomains.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.slug;
      opt.textContent = d.name || d.slug;
      sel.appendChild(opt);
    });
    sel.value = prev || "";
    // Hide the selector if there's only 0 or 1 domain
    sel.style.display = knownDomains.length <= 1 ? "none" : "";
  } catch { /* ignore */ }
}

async function onTabShown(tab) {
  if (tab === "approvals") await loadDrafts();
  else if (tab === "tasks") await loadTasks();
  else if (tab === "sops") await loadSops();
  else if (tab === "chat") await loadChatTab();
  else if (tab === "settings") await loadSettings();
  else if (tab === "logs") await loadLogs();
  else if (tab === "home") await loadHome();
}

// ------ home / status ------
async function loadHome() {
  try {
    const s = await api("GET", "/api/status");
    const bar = $("#compile-bar");
    const txt = $("#compile-text");
    const pct = s.compile?.percent ?? 0;
    bar.style.width = `${pct}%`;
    if (s.compile?.initial_compile_completed) {
      txt.textContent = `Compiled ${s.compile.compiled}/${s.compile.total} (${pct}%)`;
    } else {
      txt.textContent = `Initial compile in progress — ${s.compile.compiled}/${s.compile.total} (${pct}%)`;
    }
    $("#compile-detail").textContent =
      s.compile?.failed ? `${s.compile.failed} files skipped after retries` : "";

    $("#wake-info").textContent =
      `${s.wake.queue_size} pending · session ${s.wake.session_active ? "active" : "idle"} · ` +
      `wake ${s.wake.wake_in_flight ? "running" : "idle"}`;

    // Per-domain compile progress
    const domainsEl = $("#domains-info");
    const domains = s.domains || [];
    if (domains.length === 0) {
      domainsEl.innerHTML = '<div class="muted small">No domains registered yet.</div>';
    } else {
      domainsEl.innerHTML = "";
      domains.forEach((d) => {
        const p = d.compile || { compiled: 0, total: 0, percent: 0 };
        const lc = d.lifecycle || {};
        const indexStatus = lc.indexing?.status || "not_started";
        const el = document.createElement("div");
        el.className = "domain-compile-item";

        if (indexStatus === "not_started") {
          el.innerHTML = `
            <span class="domain-name domain-clickable" data-domain-link="${escapeHtml(d.slug)}">${escapeHtml(d.name || d.slug)}</span>
            <span class="badge" style="margin-left:auto;">not indexed</span>`;
        } else {
          el.innerHTML = `
            <span class="domain-name domain-clickable" data-domain-link="${escapeHtml(d.slug)}">${escapeHtml(d.name || d.slug)}</span>
            <div class="progress"><div class="bar" style="width:${p.percent || 0}%"></div></div>
            <span class="progress-text">${p.compiled || 0}/${p.total || 0}</span>`;
        }
        domainsEl.appendChild(el);
      });
      // Make domain names clickable
      domainsEl.querySelectorAll("[data-domain-link]").forEach((el) =>
        el.addEventListener("click", () => showDomainPage(el.dataset.domainLink)),
      );
    }

    showSetupBanner(s.setup);

    // Failures are the loudest thing on the page — anything that didn't
    // send must be impossible to miss.
    const failureTotal = s.failures?.total || 0;
    if (failureTotal > 0) {
      await loadFailures();
    } else {
      $("#failures-banner").classList.add("hidden");
    }

    const pill = $("#status-pill");
    if (failureTotal > 0) {
      pill.textContent = `${failureTotal} failed`;
      pill.className = "status-pill err";
    } else if (s.setup && !s.setup.ready) {
      pill.textContent = "setup";
      pill.className = "status-pill warn";
    } else if (!s.compile?.initial_compile_completed) {
      pill.textContent = "compiling";
      pill.className = "status-pill warn";
    } else if (s.wake.wake_in_flight) {
      pill.textContent = "thinking";
      pill.className = "status-pill warn";
    } else {
      pill.textContent = "ready";
      pill.className = "status-pill ok";
    }
  } catch (err) {
    $("#status-pill").textContent = "offline";
    $("#status-pill").className = "status-pill err";
    console.error(err);
  }
}

// ------ failed sends ------
async function loadFailures() {
  const banner = $("#failures-banner");
  const summary = $("#failures-summary");
  const list = $("#failures-list");
  try {
    const data = await api("GET", "/api/failures");
    if (!data.total) {
      banner.classList.add("hidden");
      return;
    }
    banner.classList.remove("hidden");
    const parts = [];
    if (data.email.length) parts.push(`${data.email.length} email`);
    if (data.telegram.length) parts.push(`${data.telegram.length} telegram`);
    summary.textContent =
      parts.join(" and ") +
      " failed after retries. They have NOT gone out. Fix the problem, then Retry — or Discard to drop the message entirely.";

    list.innerHTML = "";
    const all = [
      ...data.email.map((f) => ({ ...f, channel: "email" })),
      ...data.telegram.map((f) => ({ ...f, channel: "telegram" })),
    ];
    all.forEach((f) => {
      const el = document.createElement("div");
      el.className = "list-item";
      const subj = f.summary?.subject || f.summary?.text || "(no subject)";
      const to = f.summary?.to || f.summary?.chat_id || "";
      el.innerHTML = `
        <div class="title-row">
          <strong>${escapeHtml(String(subj))}</strong>
          <span class="badge">${escapeHtml(f.channel)}</span>
        </div>
        <div class="meta">to ${escapeHtml(String(to || "—"))} · ${escapeHtml(f.failed_at || "")}</div>
        <pre class="logs" style="max-height:160px; margin-top:8px;">${escapeHtml(f.error)}</pre>
        <div class="btn-row">
          <button class="primary" data-retry="${escapeHtml(f.channel)}:${escapeHtml(f.file)}">Retry</button>
          <button class="danger" data-discard="${escapeHtml(f.channel)}:${escapeHtml(f.file)}">Discard</button>
        </div>`;
      list.appendChild(el);
    });

    list.querySelectorAll("[data-retry]").forEach((b) =>
      b.addEventListener("click", async () => {
        const [channel, file] = b.dataset.retry.split(":");
        try {
          await api(
            "POST",
            `/api/failures/${encodeURIComponent(channel)}/${encodeURIComponent(file)}/retry`,
          );
          await loadHome();
        } catch (err) { alert(err.message); }
      }),
    );
    list.querySelectorAll("[data-discard]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Permanently discard this message? It will NOT be sent.")) return;
        const [channel, file] = b.dataset.discard.split(":");
        try {
          await api(
            "DELETE",
            `/api/failures/${encodeURIComponent(channel)}/${encodeURIComponent(file)}`,
          );
          await loadHome();
        } catch (err) { alert(err.message); }
      }),
    );
  } catch (err) {
    summary.textContent = err.message;
  }
}

// ------ approvals ------
async function loadDrafts() {
  const list = $("#drafts-list");
  list.textContent = "loading…";
  try {
    const drafts = await api("GET", "/api/drafts");
    if (!drafts.length) { list.innerHTML = '<div class="muted small">Nothing to approve.</div>'; return; }
    list.innerHTML = "";
    drafts.forEach((d) => {
      const el = document.createElement("div");
      el.className = "list-item";
      const fm = d.frontmatter || {};
      const kind = fm.kind || "draft";
      const isPending = fm.approved !== true && fm.approved !== false;
      const status = fm.approved === true ? '<span class="badge ok">approved</span>'
                    : fm.approved === false ? '<span class="badge warn">rejected</span>'
                    : '<span class="badge">pending</span>';
      el.innerHTML = `
        <div class="title-row">
          <strong>${escapeHtml(fm.title || d.filename)}</strong>
          ${status}
        </div>
        <div class="meta">${escapeHtml(kind)} · ${escapeHtml(d.filename)}</div>
        <textarea class="draft-body" data-draft="${escapeHtml(d.filename)}" rows="12" ${isPending ? "" : "disabled"}>${escapeHtml(d.preview)}</textarea>
        ${isPending ? `<div class="btn-row">
          <button class="primary" data-approve="${escapeHtml(d.filename)}">Approve</button>
          <button class="danger" data-reject="${escapeHtml(d.filename)}">Reject</button>
        </div>` : ""}`;
      list.appendChild(el);
    });

    list.querySelectorAll("[data-approve]").forEach((b) =>
      b.addEventListener("click", async () => {
        const textarea = b.closest(".list-item").querySelector("textarea");
        const editedBody = textarea ? textarea.value : undefined;
        await api("POST", `/api/drafts/${encodeURIComponent(b.dataset.approve)}/approve`, { edited_body: editedBody });
        loadDrafts();
      }),
    );
    list.querySelectorAll("[data-reject]").forEach((b) =>
      b.addEventListener("click", async () => {
        const reason = prompt("Reason for rejecting:", "") || "";
        await api("POST", `/api/drafts/${encodeURIComponent(b.dataset.reject)}/reject`, { reason });
        loadDrafts();
      }),
    );
  } catch (err) { list.textContent = err.message; }
}

// ------ tasks ------
async function loadTasks() {
  try {
    const data = await api("GET", "/api/tasks");
    const filter = selectedDomain;
    const filterFn = filter
      ? (t) => (t.state && t.state.domain) === filter
      : () => true;
    renderTaskList($("#tasks-active"), data.active.filter(filterFn), "active");
    renderTaskList($("#tasks-done"), data.done.filter(filterFn), "done");
  } catch (err) {
    $("#tasks-active").textContent = err.message;
  }
}

function renderTaskList(container, tasks, status) {
  if (!tasks.length) { container.innerHTML = '<div class="muted small">nothing here.</div>'; return; }
  container.innerHTML = "";
  tasks.forEach((t) => {
    const el = document.createElement("div");
    el.className = "list-item";
    const state = t.state || {};
    const statusBadge = state.status ? `<span class="badge">${escapeHtml(state.status)}</span>` : "";
    const domainBadge = state.domain ? `<span class="badge domain">${escapeHtml(state.domain)}</span>` : "";
    el.innerHTML = `
      <div class="title-row">
        <strong>${escapeHtml(state.title || t.id)}</strong>
        ${domainBadge}${statusBadge}
      </div>
      <div class="meta">${escapeHtml(state.sop || "")} · ${escapeHtml(t.updated_at)}</div>
      <div class="btn-row">
        <button data-open-task="${escapeHtml(t.id)}" data-status="${escapeHtml(status)}">Open</button>
      </div>
      <div class="task-detail hidden"></div>`;
    container.appendChild(el);
  });
  container.querySelectorAll("[data-open-task]").forEach((b) =>
    b.addEventListener("click", async () => {
      const detail = b.closest(".list-item").querySelector(".task-detail");
      if (!detail.classList.contains("hidden")) {
        detail.classList.add("hidden");
        detail.innerHTML = "";
        b.textContent = "Open";
        return;
      }
      detail.classList.remove("hidden");
      detail.textContent = "loading…";
      b.textContent = "Close";
      try {
        const r = await api(
          "GET",
          `/api/tasks/${encodeURIComponent(b.dataset.status)}/${encodeURIComponent(b.dataset.openTask)}`,
        );
        renderTaskDetail(detail, r);
      } catch (err) {
        detail.textContent = err.message;
      }
    }),
  );
}

function renderTaskDetail(container, data) {
  container.innerHTML = "";
  if (!data.files || !data.files.length) {
    container.innerHTML = '<div class="muted small">empty folder.</div>';
    return;
  }
  data.files.forEach((f) => {
    const block = document.createElement("div");
    block.className = "task-file";
    if (f.kind === "dir") {
      block.innerHTML = `<div class="meta">📁 ${escapeHtml(f.name)}/</div>`;
    } else if (typeof f.content === "string") {
      block.innerHTML = `
        <div class="meta"><strong>${escapeHtml(f.name)}</strong></div>
        <pre class="logs" style="max-height:400px;">${escapeHtml(f.content)}</pre>`;
    } else {
      block.innerHTML = `<div class="meta">📄 ${escapeHtml(f.name)} <span class="muted small">(binary)</span></div>`;
    }
    container.appendChild(block);
  });
}

// ------ sops ------
let editingSopId = null;

async function loadSops() {
  const list = $("#sops-list");
  list.textContent = "loading…";
  try {
    let sops = await api("GET", "/api/sops");
    // Client-side domain filter
    if (selectedDomain) {
      sops = sops.filter((s) => {
        const domains = s.frontmatter?.domains || [];
        return domains.includes(selectedDomain);
      });
    }
    if (!sops.length) { list.innerHTML = '<div class="muted small">No SOPs yet.</div>'; return; }
    list.innerHTML = "";
    sops.forEach((s) => {
      const el = document.createElement("div");
      el.className = "list-item";
      const domains = s.frontmatter?.domains || [];
      const domainBadges = domains.map((d) => `<span class="badge domain">${escapeHtml(d)}</span>`).join("");
      el.innerHTML = `
        <div class="title-row">
          <strong>${escapeHtml(s.frontmatter?.title || s.id)}</strong>
          ${domainBadges}
          <button data-edit="${escapeHtml(s.id)}">Edit</button>
        </div>
        <div class="meta">${escapeHtml(s.id)} — ${escapeHtml(s.frontmatter?.summary || "")}</div>`;
      list.appendChild(el);
    });
    list.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => openSopEditor(b.dataset.edit)),
    );
  } catch (err) { list.textContent = err.message; }
}

async function openSopEditor(id) {
  editingSopId = id;
  const card = $("#sop-editor-card");
  card.classList.remove("hidden");
  $("#sop-editor-title").textContent = id ? "Edit SOP" : "New SOP";
  $("#sop-editor-id").value = id || "";
  $("#sop-editor-id").disabled = !!id;
  if (id) {
    try {
      const r = await api("GET", `/api/sops/${encodeURIComponent(id)}`);
      $("#sop-editor-body").value = r.content;
    } catch (err) { alert(err.message); }
  } else {
    $("#sop-editor-body").value = "---\ntitle: New SOP\nsummary: \n---\n\n## Steps\n\n1. …\n";
  }
  window.scrollTo({ top: card.offsetTop - 60, behavior: "smooth" });
}

$("#btn-new-sop")?.addEventListener("click", () => openSopEditor(null));
$("#btn-cancel-sop")?.addEventListener("click", () => {
  $("#sop-editor-card").classList.add("hidden");
  editingSopId = null;
});
$("#btn-save-sop")?.addEventListener("click", async () => {
  const id = $("#sop-editor-id").value.trim();
  const content = $("#sop-editor-body").value;
  if (!id) { alert("id is required"); return; }
  try {
    await api("PUT", `/api/sops/${encodeURIComponent(id)}`, { content });
    $("#sop-editor-card").classList.add("hidden");
    loadSops();
  } catch (err) { alert(err.message); }
});
$("#btn-delete-sop")?.addEventListener("click", async () => {
  if (!editingSopId) { $("#sop-editor-card").classList.add("hidden"); return; }
  if (!confirm(`Delete SOP "${editingSopId}"?`)) return;
  try {
    await api("DELETE", `/api/sops/${encodeURIComponent(editingSopId)}`);
    $("#sop-editor-card").classList.add("hidden");
    loadSops();
  } catch (err) { alert(err.message); }
});

// ------ settings ------
// Each settings endpoint returns `{data, body}`. The wizard and the settings
// tab share the same field-reading/field-writing helpers below.
let lastSettingsBodies = { workspace: "", providers: "", wakes: "" };

function fillWorkspaceForm(ws) {
  $("#ws-name").value = ws.workspace_name || "";
  $("#ws-user-name").value = ws.user_name || "";
  $("#ws-user-email").value = ws.user_email || "";
  $("#ws-ai-name").value = ws.ai_name || "";
  $("#ws-ai-job").value = ws.ai_job_description || "";
  $("#ws-ai-cli").value = ws.ai_cli || "claude";
  $("#ws-playground-path").value = ws.playground_path || "";
}
function readWorkspaceForm() {
  return {
    workspace_name: $("#ws-name").value.trim(),
    user_name: $("#ws-user-name").value.trim(),
    user_email: $("#ws-user-email").value.trim(),
    ai_name: $("#ws-ai-name").value.trim() || "Sarah",
    ai_job_description: $("#ws-ai-job").value.trim() || "Manager",
    ai_cli: $("#ws-ai-cli").value,
    playground_path: $("#ws-playground-path").value.trim(),
  };
}
function fillProvidersForm(pr) {
  $("#pr-lmstudio-url").value = pr.lm_studio_url || "";
  $("#pr-lmstudio-model").value = pr.lm_studio_model || "";
  // Email backend + Gmail OAuth fields
  const backend = pr.email_backend || "imap";
  $("#pr-email-backend").value = backend;
  $("#pr-gmail-client-id").value = pr.gmail_client_id || "";
  $("#pr-gmail-client-secret").value = pr.gmail_client_secret || "";
  $("#pr-gmail-aliases").value = (pr.gmail_send_aliases || []).join(", ");
  // IMAP / SMTP (legacy)
  $("#pr-imap-host").value = pr.email_imap_host || "";
  $("#pr-imap-port").value = pr.email_imap_port || 993;
  $("#pr-imap-user").value = pr.email_imap_user || "";
  $("#pr-imap-pass").value = pr.email_imap_password || "";
  $("#pr-smtp-host").value = pr.email_smtp_host || "";
  $("#pr-smtp-port").value = pr.email_smtp_port || 587;
  $("#pr-smtp-user").value = pr.email_smtp_user || "";
  $("#pr-smtp-pass").value = pr.email_smtp_password || "";
  $("#pr-smtp-from").value = pr.email_smtp_from || "";
  $("#pr-tg-token").value = pr.telegram_bot_token || "";
  $("#pr-tg-allowed").value = (pr.telegram_allowed_chat_ids || []).join(",");
  $("#pr-tg-default").value = pr.telegram_default_chat_id || "";
  updateEmailBackendVisibility();
  refreshGmailStatus();
}
function readProvidersForm() {
  return {
    lm_studio_url: $("#pr-lmstudio-url").value.trim() || "http://127.0.0.1:1234",
    lm_studio_model: $("#pr-lmstudio-model").value.trim(),
    email_backend: $("#pr-email-backend").value,
    gmail_client_id: $("#pr-gmail-client-id").value.trim(),
    gmail_client_secret: $("#pr-gmail-client-secret").value.trim(),
    gmail_send_aliases: $("#pr-gmail-aliases").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    email_imap_host: $("#pr-imap-host").value.trim(),
    email_imap_port: parseInt($("#pr-imap-port").value || "993", 10),
    email_imap_user: $("#pr-imap-user").value.trim(),
    email_imap_password: $("#pr-imap-pass").value,
    email_smtp_host: $("#pr-smtp-host").value.trim(),
    email_smtp_port: parseInt($("#pr-smtp-port").value || "587", 10),
    email_smtp_user: $("#pr-smtp-user").value.trim(),
    email_smtp_password: $("#pr-smtp-pass").value,
    email_smtp_from: $("#pr-smtp-from").value.trim(),
    telegram_bot_token: $("#pr-tg-token").value.trim(),
    telegram_allowed_chat_ids: $("#pr-tg-allowed").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    telegram_default_chat_id: $("#pr-tg-default").value.trim(),
  };
}

function updateEmailBackendVisibility() {
  const backend = $("#pr-email-backend")?.value || "imap";
  $("#pr-gmail-section")?.classList.toggle("hidden", backend !== "gmail_oauth");
  $("#pr-imap-section")?.classList.toggle("hidden", backend !== "imap");
}

async function refreshGmailStatus() {
  const el = $("#pr-gmail-status");
  const disconnectBtn = $("#btn-disconnect-gmail");
  if (!el) return;
  try {
    const s = await api("GET", "/api/auth/gmail/status");
    if (!s.client_id_configured) {
      el.textContent = "Status: client ID + secret not saved yet. Paste them and click Save email settings first.";
      disconnectBtn?.classList.add("hidden");
    } else if (s.connected) {
      el.innerHTML = `Status: <strong>connected</strong> as <code>${escapeHtml(s.user_email)}</code>`;
      disconnectBtn?.classList.remove("hidden");
    } else {
      el.textContent = "Status: client ID saved but not yet authorized. Click Connect Gmail to run the consent flow.";
      disconnectBtn?.classList.add("hidden");
    }
  } catch (err) {
    el.textContent = "Status: could not reach server — " + err.message;
  }
}

$("#pr-email-backend")?.addEventListener("change", updateEmailBackendVisibility);
$("#btn-connect-gmail")?.addEventListener("click", async () => {
  // Save any unsaved client ID / secret first so the server has them
  try {
    await saveAllProviders("Saving before Connect…");
  } catch (err) { alert(err.message); return; }
  // Full-page redirect so Google's consent flow works without popup blockers
  window.location.href = "/api/auth/gmail/start";
});
$("#btn-disconnect-gmail")?.addEventListener("click", async () => {
  if (!confirm("Disconnect Gmail? Sarah won't be able to read or send email until you reconnect.")) return;
  try {
    await api("POST", "/api/auth/gmail/disconnect");
    flash("Gmail disconnected.");
    await refreshGmailStatus();
  } catch (err) { alert(err.message); }
});

async function loadSettings() {
  try {
    const [id, ws, pr, wk] = await Promise.all([
      api("GET", "/api/settings/identity"),
      api("GET", "/api/settings/workspace"),
      api("GET", "/api/settings/providers"),
      api("GET", "/api/settings/wakes"),
    ]);
    $("#settings-identity").value = id.content || "";
    lastSettingsBodies.workspace = ws.body || "";
    lastSettingsBodies.providers = pr.body || "";
    lastSettingsBodies.wakes = wk.body || "";
    fillWorkspaceForm(ws.data || {});
    fillProvidersForm(pr.data || {});
    $("#wk-times").value = ((wk.data && wk.data.wake_times) || []).join("\n");
    await loadDomainsSettings();
  } catch (err) { alert(err.message); }
}

$("#btn-save-identity")?.addEventListener("click", async () => {
  try {
    await api("PUT", "/api/settings/identity", { content: $("#settings-identity").value });
    flash("Saved identity.");
    refreshSetup();
  } catch (err) { alert(err.message); }
});
$("#btn-save-workspace")?.addEventListener("click", async () => {
  try {
    await api("PUT", "/api/settings/workspace", {
      data: readWorkspaceForm(),
      body: lastSettingsBodies.workspace,
    });
    flash("Saved workspace.");
    refreshSetup();
  } catch (err) { alert(err.message); }
});
async function saveAllProviders(msg) {
  await api("PUT", "/api/settings/providers", {
    data: readProvidersForm(),
    body: lastSettingsBodies.providers,
  });
  flash(msg || "Saved.");
  refreshSetup();
}
$("#btn-save-email")?.addEventListener("click", async () => {
  try { await saveAllProviders("Saved email settings."); } catch (err) { alert(err.message); }
});
$("#btn-save-telegram")?.addEventListener("click", async () => {
  try { await saveAllProviders("Saved telegram settings."); } catch (err) { alert(err.message); }
});
$("#btn-save-engine")?.addEventListener("click", async () => {
  try { await saveAllProviders("Saved AI engine settings."); } catch (err) { alert(err.message); }
});
$("#btn-save-wakes")?.addEventListener("click", async () => {
  try {
    const times = $("#wk-times").value.split("\n").map((s) => s.trim()).filter(Boolean);
    await api("PUT", "/api/settings/wakes", {
      data: { wake_times: times },
      body: lastSettingsBodies.wakes,
    });
    flash("Saved schedule.");
    refreshSetup();
  } catch (err) { alert(err.message); }
});

// ------ settings sub-tabs ------
function initSettingsNav() {
  $$("#settings-nav button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#settings-nav button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".stab").forEach((t) => t.classList.remove("active"));
      const target = document.getElementById(`stab-${btn.dataset.stab}`);
      if (target) target.classList.add("active");
    });
  });
}

// ------ domains management (settings tab) ------
async function loadDomainsSettings() {
  const list = $("#domains-settings-list");
  if (!list) return;
  try {
    const domains = await api("GET", "/api/domains");
    if (!domains.length) {
      list.innerHTML = '<div class="muted small">No domains registered.</div>';
      return;
    }
    list.innerHTML = "";
    domains.forEach((d) => {
      const el = document.createElement("div");
      el.className = "domain-settings-item";
      const pct = d.compile?.percent ?? 0;
      const lcIdx = d.lifecycle?.indexing?.status || "not_started";
      const indexLabel = lcIdx === "not_started" ? "not indexed" : `${pct}% indexed`;
      el.innerHTML = `
        <div class="domain-header">
          <div>
            <strong class="domain-clickable" data-domain-link="${escapeHtml(d.slug)}">${escapeHtml(d.name || d.slug)}</strong>
            <span class="badge domain">${escapeHtml(d.slug)}</span>
            <div class="domain-meta">${escapeHtml(d.root)} \u00b7 ${indexLabel}</div>
          </div>
          <div class="btn-row">
            <button data-edit-domain="${escapeHtml(d.slug)}">Edit</button>
            <button data-context-domain="${escapeHtml(d.slug)}">Context</button>
            <button data-rescan="${escapeHtml(d.slug)}" title="Force re-index">Rescan</button>
            <button class="danger-outline" data-reset="${escapeHtml(d.slug)}" title="Wipe all indexed data and recompile from scratch">Reset Index</button>
            <button class="danger" data-remove="${escapeHtml(d.slug)}" title="Unregister domain">Remove</button>
          </div>
        </div>
        <div class="domain-edit-form hidden" data-edit-form="${escapeHtml(d.slug)}">
          <label>Name<input data-edit-name="${escapeHtml(d.slug)}" value="${escapeHtml(d.name || "")}" /></label>
          <label>Folder path<input data-edit-root="${escapeHtml(d.slug)}" value="${escapeHtml(d.root || "")}" /></label>
          <div class="btn-row">
            <button class="primary" data-save-edit="${escapeHtml(d.slug)}">Save changes</button>
            <button data-cancel-edit="${escapeHtml(d.slug)}">Cancel</button>
          </div>
          <p class="muted small" style="margin-top:8px;">Changing the folder path will reset the domain's index.</p>
        </div>
        <div class="domain-context-form hidden" data-context-form="${escapeHtml(d.slug)}">
          <label>Domain Context <span class="muted small">(markdown — defines Sarah's role, key people, communication rules for this domain)</span>
            <textarea data-context-content="${escapeHtml(d.slug)}" rows="20" style="font-family:monospace;font-size:13px;width:100%;"></textarea>
          </label>
          <div class="btn-row">
            <button class="primary" data-save-context="${escapeHtml(d.slug)}">Save context</button>
            <button data-cancel-context="${escapeHtml(d.slug)}">Cancel</button>
          </div>
        </div>`;
      list.appendChild(el);
    });

    // Domain name links → per-domain page
    list.querySelectorAll("[data-domain-link]").forEach((el) =>
      el.addEventListener("click", () => showDomainPage(el.dataset.domainLink)),
    );
    // Edit toggle
    list.querySelectorAll("[data-edit-domain]").forEach((b) =>
      b.addEventListener("click", () => {
        const slug = b.dataset.editDomain;
        const form = list.querySelector(`[data-edit-form="${slug}"]`);
        if (form) form.classList.toggle("hidden");
      }),
    );
    // Cancel edit
    list.querySelectorAll("[data-cancel-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        const slug = b.dataset.cancelEdit;
        const form = list.querySelector(`[data-edit-form="${slug}"]`);
        if (form) form.classList.add("hidden");
      }),
    );
    // Context toggle — load content on first open
    list.querySelectorAll("[data-context-domain]").forEach((b) =>
      b.addEventListener("click", async () => {
        const slug = b.dataset.contextDomain;
        const form = list.querySelector(`[data-context-form="${slug}"]`);
        if (!form) return;
        const wasHidden = form.classList.contains("hidden");
        form.classList.toggle("hidden");
        if (wasHidden) {
          const ta = form.querySelector(`[data-context-content="${slug}"]`);
          if (ta && !ta.dataset.loaded) {
            ta.value = "Loading…";
            try {
              const res = await api("GET", `/api/domains/${encodeURIComponent(slug)}/context`);
              ta.value = res.content || "";
              ta.dataset.loaded = "1";
            } catch (err) { ta.value = `Error: ${err.message}`; }
          }
        }
      }),
    );
    // Save context
    list.querySelectorAll("[data-save-context]").forEach((b) =>
      b.addEventListener("click", async () => {
        const slug = b.dataset.saveContext;
        const ta = list.querySelector(`[data-context-content="${slug}"]`);
        if (!ta) return;
        b.disabled = true;
        b.textContent = "Saving…";
        try {
          await api("PUT", `/api/domains/${encodeURIComponent(slug)}/context`, { content: ta.value });
          flash("Domain context saved.");
        } catch (err) { alert(err.message); }
        b.disabled = false;
        b.textContent = "Save context";
      }),
    );
    // Cancel context
    list.querySelectorAll("[data-cancel-context]").forEach((b) =>
      b.addEventListener("click", () => {
        const slug = b.dataset.cancelContext;
        const form = list.querySelector(`[data-context-form="${slug}"]`);
        if (form) form.classList.add("hidden");
      }),
    );
    // Save edit
    list.querySelectorAll("[data-save-edit]").forEach((b) =>
      b.addEventListener("click", async () => {
        const slug = b.dataset.saveEdit;
        const name = list.querySelector(`[data-edit-name="${slug}"]`)?.value.trim();
        const root = list.querySelector(`[data-edit-root="${slug}"]`)?.value.trim();
        if (!name) { alert("Name is required."); return; }
        b.disabled = true;
        b.textContent = "Saving…";
        try {
          const payload = { name };
          if (root) payload.root = root;
          await api("PUT", `/api/domains/${encodeURIComponent(slug)}`, payload);
          flash("Domain updated.");
          await loadDomainsSettings();
          await loadDomains();
        } catch (err) { alert(err.message); }
        b.disabled = false;
        b.textContent = "Save changes";
      }),
    );
    // Rescan
    list.querySelectorAll("[data-rescan]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "…";
        try {
          await api("POST", `/api/domains/${encodeURIComponent(b.dataset.rescan)}/rescan`);
          flash("Rescan started.");
        } catch (err) { alert(err.message); }
        b.disabled = false;
        b.textContent = "Rescan";
      }),
    );
    // Reset index
    list.querySelectorAll("[data-reset]").forEach((b) =>
      b.addEventListener("click", async () => {
        const slug = b.dataset.reset;
        if (!confirm(`Reset index for "${slug}"?\n\nThis will delete ALL compiled summaries and start indexing from scratch.\n\nDomain files are NOT affected.`)) return;
        b.disabled = true;
        b.textContent = "Resetting…";
        try {
          await api("POST", `/api/domains/${encodeURIComponent(slug)}/reset-index`);
          flash("Index reset — recompile started.");
          await loadDomainsSettings();
          await loadDomains();
        } catch (err) { alert(err.message); }
        b.disabled = false;
        b.textContent = "Reset Index";
      }),
    );
    // Remove
    list.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm(`Remove domain "${b.dataset.remove}"? Files won't be deleted.`)) return;
        try {
          await api("DELETE", `/api/domains/${encodeURIComponent(b.dataset.remove)}`);
          await loadDomainsSettings();
          await loadDomains();
        } catch (err) { alert(err.message); }
      }),
    );
  } catch (err) {
    list.textContent = err.message;
  }
}

$("#btn-add-domain")?.addEventListener("click", async () => {
  const name = $("#dom-new-name").value.trim();
  const slug = $("#dom-new-slug").value.trim() || name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const domPath = $("#dom-new-path").value.trim();
  if (!name || !domPath) { alert("Name and folder path are required."); return; }
  try {
    await api("POST", "/api/domains", { slug, name, path: domPath });
    $("#dom-new-name").value = "";
    $("#dom-new-slug").value = "";
    $("#dom-new-path").value = "";
    flash("Domain added.");
    await loadDomainsSettings();
    await loadDomains();
  } catch (err) { alert(err.message); }
});

// ------ logs ------
async function loadLogs() {
  try {
    const entries = await api("GET", "/api/logs?lines=200");
    const out = entries.map((e) => {
      if (e.raw) return e.raw;
      const t = e.time || "";
      const l = (e.level || "info").padEnd(5);
      const src = (e.source || "").padEnd(10);
      const msg = e.msg || "";
      const rest = { ...e }; delete rest.time; delete rest.level; delete rest.source; delete rest.msg;
      const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
      return `${t} ${l} ${src} ${msg}${extra}`;
    }).join("\n");
    $("#logs-out").textContent = out;
  } catch (err) {
    $("#logs-out").textContent = err.message;
  }
}
$("#btn-refresh-logs")?.addEventListener("click", loadLogs);
let logTimer = null;
$("#chk-autorefresh")?.addEventListener("change", (e) => {
  if (e.target.checked) { logTimer = setInterval(loadLogs, 3000); loadLogs(); }
  else if (logTimer) { clearInterval(logTimer); logTimer = null; }
});

// ------ setup wizard ------
// The wizard is a full-screen overlay that appears whenever the server
// reports `setup.ready === false`. It saves straight into the same settings
// endpoints the settings tab uses — there is no separate wizard storage.
//
// State machine: step 1..5. Steps 3 and 4 have a Skip button because the
// user only needs one channel, not both. The wizard refuses to finish until
// the /api/status response agrees that setup.ready is true.

const WIZ_TOTAL_STEPS = 5;
let wizStep = 1;
let wizOpen = false;
let wizLoaded = false;
let wizDataDirConfigured = true; // set from /api/status on open
let wizDataDirSuggestions = [];

function showSetupBanner(setup) {
  const banner = $("#setup-banner");
  if (!banner) return;
  if (!setup || setup.ready) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const missing = (setup.missing || []).map((m) => `• ${escapeHtml(m)}`).join("<br>");
  $("#setup-missing").innerHTML = missing || "Setup is incomplete.";
}

async function openWizard() {
  wizOpen = true;
  $("#wizard-overlay").classList.remove("hidden");
  $("#wizard-overlay").setAttribute("aria-hidden", "false");
  document.body.classList.add("wizard-modal-open");

  // Check whether data-dir has been configured. If not, show the folder
  // picker as step 0 before anything else.
  try {
    const st = await api("GET", "/api/status");
    wizDataDirConfigured = !!st.data_dir_configured;
  } catch {
    wizDataDirConfigured = true; // fail-closed: skip the extra step
  }
  if (!wizDataDirConfigured) {
    await loadDataDirSuggestions();
    wizStep = 0;
  } else {
    if (!wizLoaded) {
      await prefillWizard();
      wizLoaded = true;
    }
    wizStep = 1;
  }
  showWizStep();
}

async function loadDataDirSuggestions() {
  try {
    const r = await api("GET", "/api/setup/data-dir");
    wizDataDirSuggestions = r.suggestions || [];
    const host = $("#wiz-data-suggestions");
    if (!host) return;
    if (wizDataDirSuggestions.length === 0) {
      host.textContent = "(no cloud folders detected — enter a custom path below)";
      return;
    }
    host.innerHTML = wizDataDirSuggestions
      .map(
        (s, i) =>
          `<label style="display:block; padding: 0.5em; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 0.4em; cursor: pointer;">
            <input type="radio" name="wiz-data-choice" value="${i}" />
            <strong>${escapeHtml(s.label)}</strong><br>
            <span class="muted small" style="font-family: monospace;">${escapeHtml(s.default_target)}</span>
          </label>`,
      )
      .join("");
  } catch (err) {
    $("#wiz-data-suggestions").textContent = "Could not load suggestions: " + err.message;
  }
}

function closeWizard() {
  wizOpen = false;
  $("#wizard-overlay").classList.add("hidden");
  $("#wizard-overlay").setAttribute("aria-hidden", "true");
  document.body.classList.remove("wizard-modal-open");
}

async function prefillWizard() {
  try {
    const [id, ws, pr, wk] = await Promise.all([
      api("GET", "/api/settings/identity"),
      api("GET", "/api/settings/workspace"),
      api("GET", "/api/settings/providers"),
      api("GET", "/api/settings/wakes"),
    ]);
    $("#wiz-identity").value = id.content || "";
    const w = ws.data || {};
    $("#wiz-workspace-name").value = w.workspace_name || "";
    $("#wiz-user-name").value = w.user_name || "";
    $("#wiz-user-email").value = w.user_email || "";
    $("#wiz-ai-name").value = w.ai_name || "Sarah";
    $("#wiz-ai-job").value = w.ai_job_description || "Manager";
    const p = pr.data || {};
    $("#wiz-imap-host").value = p.email_imap_host || "";
    $("#wiz-imap-port").value = p.email_imap_port || 993;
    $("#wiz-imap-user").value = p.email_imap_user || "";
    $("#wiz-imap-pass").value = p.email_imap_password || "";
    $("#wiz-smtp-host").value = p.email_smtp_host || "";
    $("#wiz-smtp-port").value = p.email_smtp_port || 587;
    $("#wiz-smtp-user").value = p.email_smtp_user || "";
    $("#wiz-smtp-pass").value = p.email_smtp_password || "";
    $("#wiz-smtp-from").value = p.email_smtp_from || "";
    $("#wiz-tg-token").value = p.telegram_bot_token || "";
    $("#wiz-tg-allowed").value = (p.telegram_allowed_chat_ids || []).join(",");
    $("#wiz-tg-default").value = p.telegram_default_chat_id || "";
    $("#wiz-wakes").value = ((wk.data && wk.data.wake_times) || []).join("\n");
    lastSettingsBodies.workspace = ws.body || "";
    lastSettingsBodies.providers = pr.body || "";
    lastSettingsBodies.wakes = wk.body || "";
  } catch (err) {
    showWizardError(err.message);
  }
}

function showWizStep() {
  $$(".wizard-step").forEach((el) => {
    el.classList.toggle("hidden", Number(el.dataset.step) !== wizStep);
  });
  if (wizStep === 0) {
    $("#wizard-progress").textContent = "Where to store your work";
  } else {
    $("#wizard-progress").textContent = `Step ${wizStep} of ${WIZ_TOTAL_STEPS}`;
  }
  $("#wiz-back").disabled = wizStep <= 1;
  $("#wiz-next").textContent = wizStep === WIZ_TOTAL_STEPS ? "Finish" : "Next";
  // Skip button is only meaningful on optional channel steps.
  const skippable = wizStep === 3 || wizStep === 4 || wizStep === 5;
  $("#wiz-skip").classList.toggle("hidden", !skippable);
  hideWizardError();
}

function showWizardError(msg) {
  const el = $("#wizard-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideWizardError() {
  $("#wizard-error").classList.add("hidden");
}

// Validate + persist whatever the current step captures. Returns true if OK,
// false if we should stay on the step.
async function saveWizStep(step) {
  if (step === 0) {
    // Data-dir folder picker. Collect choice, POST, then instruct the
    // user to restart — the running server has the old paths cached, so
    // the rest of the wizard must run against a restarted server.
    const custom = $("#wiz-data-custom").value.trim();
    let targetPath = custom;
    if (!targetPath) {
      const radio = document.querySelector('input[name="wiz-data-choice"]:checked');
      if (radio) {
        const idx = parseInt(radio.value, 10);
        targetPath = wizDataDirSuggestions[idx]?.default_target || "";
      }
    }
    if (!targetPath) {
      showWizardError("Pick one of the suggested folders, or enter a custom path.");
      return false;
    }
    try {
      const resp = await api("POST", "/api/setup/data-dir", { path: targetPath });
      if (resp.ok === false) {
        showWizardError(resp.error || "Failed to set data dir.");
        return false;
      }
      // Show the restart banner, freeze the wizard. The user must restart
      // Dovai before the rest of the wizard can write to the new location.
      $("#wiz-data-restart-banner").classList.remove("hidden");
      $("#wiz-next").disabled = true;
      $("#wiz-back").disabled = true;
      return false; // don't advance
    } catch (err) {
      showWizardError(err.message);
      return false;
    }
  }
  if (step === 1) {
    const content = $("#wiz-identity").value.trim();
    if (content.length < 40) {
      showWizardError("Tell Sarah at least a short paragraph about who she works for.");
      return false;
    }
    await api("PUT", "/api/settings/identity", { content: $("#wiz-identity").value });
    return true;
  }
  if (step === 2) {
    const data = {
      workspace_name: $("#wiz-workspace-name").value.trim(),
      user_name: $("#wiz-user-name").value.trim(),
      user_email: $("#wiz-user-email").value.trim(),
      ai_name: $("#wiz-ai-name").value.trim() || "Sarah",
      ai_job_description: $("#wiz-ai-job").value.trim() || "Manager",
    };
    if (!data.workspace_name || !data.user_name || !data.user_email) {
      showWizardError("Workspace name, your name, and your email are all required.");
      return false;
    }
    await api("PUT", "/api/settings/workspace", {
      data,
      body: lastSettingsBodies.workspace,
    });
    return true;
  }
  if (step === 3 || step === 4) {
    // Channels write into the same providers.md, so we always write the
    // full current state of both.
    const data = buildProvidersFromWizard();
    await api("PUT", "/api/settings/providers", {
      data,
      body: lastSettingsBodies.providers,
    });
    return true;
  }
  if (step === 5) {
    const times = $("#wiz-wakes").value.split("\n").map((s) => s.trim()).filter(Boolean);
    await api("PUT", "/api/settings/wakes", {
      data: { wake_times: times },
      body: lastSettingsBodies.wakes,
    });
    return true;
  }
  return true;
}

function buildProvidersFromWizard() {
  return {
    lm_studio_url: "http://127.0.0.1:1234",
    lm_studio_model: "",
    email_imap_host: $("#wiz-imap-host").value.trim(),
    email_imap_port: parseInt($("#wiz-imap-port").value || "993", 10),
    email_imap_user: $("#wiz-imap-user").value.trim(),
    email_imap_password: $("#wiz-imap-pass").value,
    email_smtp_host: $("#wiz-smtp-host").value.trim(),
    email_smtp_port: parseInt($("#wiz-smtp-port").value || "587", 10),
    email_smtp_user: $("#wiz-smtp-user").value.trim(),
    email_smtp_password: $("#wiz-smtp-pass").value,
    email_smtp_from: $("#wiz-smtp-from").value.trim(),
    telegram_bot_token: $("#wiz-tg-token").value.trim(),
    telegram_allowed_chat_ids: $("#wiz-tg-allowed").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    telegram_default_chat_id: $("#wiz-tg-default").value.trim(),
  };
}

$("#wiz-next")?.addEventListener("click", async () => {
  try {
    const ok = await saveWizStep(wizStep);
    if (!ok) return;
    if (wizStep < WIZ_TOTAL_STEPS) {
      wizStep += 1;
      showWizStep();
    } else {
      // Final step — re-check setup status, only dismiss if ready.
      const status = await api("GET", "/api/status");
      if (status.setup && status.setup.ready) {
        closeWizard();
        await loadHome();
      } else {
        const missing = (status.setup?.missing || []).join(", ");
        showWizardError(
          `Still missing: ${missing}. Go back and fill in at least one channel (email or telegram).`,
        );
      }
    }
  } catch (err) {
    showWizardError(err.message);
  }
});

$("#wiz-back")?.addEventListener("click", () => {
  if (wizStep > 1) {
    wizStep -= 1;
    showWizStep();
  }
});

$("#wiz-skip")?.addEventListener("click", () => {
  if (wizStep === 3) {
    // Skip email — clear the fields so the user doesn't save a half-filled
    // channel by accident.
    ["wiz-imap-host", "wiz-imap-user", "wiz-imap-pass",
     "wiz-smtp-host", "wiz-smtp-user", "wiz-smtp-pass", "wiz-smtp-from"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    wizStep = 4;
    showWizStep();
  } else if (wizStep === 4) {
    ["wiz-tg-token", "wiz-tg-allowed", "wiz-tg-default"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    wizStep = 5;
    showWizStep();
  } else if (wizStep === 5) {
    $("#wiz-wakes").value = "";
    $("#wiz-next").click();
  }
});

$("#btn-open-wizard")?.addEventListener("click", () => openWizard());

async function refreshSetup() {
  try {
    const s = await api("GET", "/api/status");
    showSetupBanner(s.setup);
    // Auto-open the wizard on first load if setup isn't ready yet.
    if (s.setup && !s.setup.ready && !wizOpen) {
      await openWizard();
    }
  } catch { /* ignore */ }
}

// ------ per-domain page ------
let domainPageSlug = null;
let domainPreviousTab = "home";

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function showDomainPage(slug) {
  domainPageSlug = slug;
  // Remember which tab was active
  const active = $(".tabs button.active");
  if (active && active.dataset.tab !== "domain") {
    domainPreviousTab = active.dataset.tab;
  }

  // Switch to the domain tab
  $$("#tabs button").forEach((b) => b.classList.remove("active"));
  $$(".tab").forEach((t) => t.classList.remove("active"));
  const domainTab = $("#tab-domain");
  if (domainTab) domainTab.classList.add("active");

  // Show loading state
  $("#domain-page-name").textContent = slug;
  $("#domain-page-path").textContent = "Loading\u2026";
  $("#domain-page-size").textContent = "";
  $("#domain-backup-body").textContent = "Loading\u2026";
  $("#domain-indexing-body").textContent = "Loading\u2026";

  try {
    const d = await api("GET", `/api/domains/${encodeURIComponent(slug)}`);
    renderDomainPage(d);
  } catch (err) {
    $("#domain-page-path").textContent = err.message;
  }
}

function renderDomainPage(d) {
  // Header
  $("#domain-page-name").textContent = d.name || d.slug;
  $("#domain-page-path").textContent = d.root;
  if (d.size) {
    const parts = [`${d.size.file_count.toLocaleString()} files`, formatBytes(d.size.total_bytes)];
    if (d.size.band) parts.push(d.size.band);
    $("#domain-page-size").textContent = parts.join(" \u00b7 ");
  }

  // Backup card
  const backupEl = $("#domain-backup-body");
  const lc = d.lifecycle || {};
  const backupStatus = lc.backup?.status || "pending";

  if (backupStatus === "complete" && d.backup) {
    backupEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge ok">Complete</span>
      </div>
      <div class="domain-stat-row">
        <span class="domain-stat-label">Created</span>
        <span class="domain-stat-value">${escapeHtml(d.backup.created_at || "")}</span>
      </div>
      <div class="domain-stat-row">
        <span class="domain-stat-label">Method</span>
        <span class="domain-stat-value">${escapeHtml(d.backup.method === "apfs_clone" ? "APFS clone (zero-cost)" : "File copy")}</span>
      </div>
      <div class="domain-stat-row">
        <span class="domain-stat-label">Files</span>
        <span class="domain-stat-value">${(d.backup.file_count || 0).toLocaleString()} \u00b7 ${formatBytes(d.backup.total_bytes || 0)}</span>
      </div>
      <div class="domain-stat-row">
        <span class="domain-stat-label">Location</span>
        <span class="domain-stat-value small" style="word-break:break-all;">${escapeHtml(d.backup.backup_root || "")}</span>
      </div>
      <div class="btn-row">
        <button class="danger-outline" id="btn-backup-restore">Restore</button>
        <button class="danger-outline" id="btn-backup-delete">Delete backup</button>
      </div>`;
    $("#btn-backup-restore")?.addEventListener("click", () => restoreDomainBackup(d.slug));
    $("#btn-backup-delete")?.addEventListener("click", () => deleteDomainBackup(d.slug));
  } else if (backupStatus === "declined") {
    backupEl.innerHTML = '<div class="muted small">Backup was deleted or declined.</div>';
  } else {
    backupEl.innerHTML = '<div class="muted small">No backup available.</div>';
  }

  // Smart Folders card
  const sfStatus = lc.smart_folders?.status || "not_started";
  renderSmartFoldersCard(d);

  // Triage card
  const triageCard = $("#domain-triage-card");
  if (sfStatus === "complete") {
    triageCard.classList.remove("hidden");
    loadTriageTable(d.slug);
  } else {
    triageCard.classList.add("hidden");
  }

  // Indexing card
  const indexEl = $("#domain-indexing-body");
  const indexStatus = lc.indexing?.status || "not_started";
  const compile = d.compile || {};

  if (indexStatus === "not_started") {
    indexEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge">Not started</span>
      </div>
      <p class="muted small" style="margin:8px 0 0;">
        Indexing has not been started for this domain. Start it when you're ready.
      </p>
      <div class="btn-row">
        <button class="primary" id="btn-start-indexing">Start Indexing</button>
      </div>`;
    $("#btn-start-indexing")?.addEventListener("click", () => startDomainIndexing(d.slug));
  } else if (indexStatus === "running") {
    const pct = compile.percent || 0;
    const compiled = compile.compiled || 0;
    const total = compile.total || 0;
    indexEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge warn">Running</span>
      </div>
      <div class="progress-wrap" style="margin-top:8px;">
        <div class="progress"><div class="bar" style="width:${pct}%"></div></div>
        <div class="progress-text">${compiled}/${total} files (${pct}%)</div>
      </div>
      ${compile.failed ? `<div class="muted small" style="margin-top:4px;">${compile.failed} files failed</div>` : ""}`;
  } else if (indexStatus === "complete") {
    const pct = compile.percent || 100;
    const compiled = compile.compiled || 0;
    const total = compile.total || 0;
    indexEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge ok">Complete</span>
      </div>
      <div class="domain-stat-row">
        <span class="domain-stat-label">Files indexed</span>
        <span class="domain-stat-value">${compiled}/${total} (${pct}%)</span>
      </div>
      ${compile.failed ? `<div class="domain-stat-row"><span class="domain-stat-label">Failed</span><span class="domain-stat-value" style="color:var(--err);">${compile.failed}</span></div>` : ""}
      ${lc.indexing.completed_at ? `<div class="domain-stat-row"><span class="domain-stat-label">Completed</span><span class="domain-stat-value">${escapeHtml(lc.indexing.completed_at)}</span></div>` : ""}`;
  }
}

async function startDomainIndexing(slug) {
  const btn = $("#btn-start-indexing");
  if (btn) { btn.disabled = true; btn.textContent = "Starting\u2026"; }
  try {
    await api("POST", `/api/domains/${encodeURIComponent(slug)}/indexing/start`);
    flash("Indexing started.");
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

async function restoreDomainBackup(slug) {
  if (!confirm(`Restore "${slug}" to its pre-Dovai state?\n\nThis will:\n- Stop indexing\n- Replace all files with the backup\n- Reset Smart Folders and indexing state\n\nAny files added after the backup are preserved in a separate snapshot.`)) return;
  const btn = $("#btn-backup-restore");
  if (btn) { btn.disabled = true; btn.textContent = "Restoring\u2026"; }
  try {
    const r = await api("POST", `/api/domains/${encodeURIComponent(slug)}/backup/restore`);
    alert(`Restored ${r.restored_files} files.\n\nPre-restore snapshot saved at:\n${r.snapshot_path}`);
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

async function deleteDomainBackup(slug) {
  if (!confirm(`Delete the pre-Dovai backup for "${slug}"?\n\nThis frees disk space but you will no longer be able to restore to the pre-Dovai state.`)) return;
  const btn = $("#btn-backup-delete");
  if (btn) { btn.disabled = true; btn.textContent = "Deleting\u2026"; }
  try {
    await api("DELETE", `/api/domains/${encodeURIComponent(slug)}/backup`);
    flash("Backup deleted.");
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

function renderSmartFoldersCard(d) {
  const sfEl = $("#domain-sf-body");
  const lc = d.lifecycle || {};
  const sfStatus = lc.smart_folders?.status || "not_started";

  if (sfStatus === "not_started") {
    sfEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge">Not started</span>
      </div>
      <p class="muted small" style="margin:8px 0 0;">
        Smart Folders uses a cloud LLM to reorganise your files into a clean structure
        and decide which files are worth indexing. This is optional but recommended for
        large or messy domains.
      </p>
      <div class="btn-row">
        <button class="primary" id="btn-start-sf">Start Smart Folders</button>
        <button class="secondary" id="btn-skip-sf">Skip</button>
      </div>`;
    $("#btn-start-sf")?.addEventListener("click", () => startSmartFolders(d.slug));
    $("#btn-skip-sf")?.addEventListener("click", () => skipSmartFolders(d.slug));
  } else if (sfStatus === "running") {
    sfEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge warn">Running</span>
      </div>
      <div id="sf-progress-area" class="muted small" style="margin-top:8px;">Loading progress\u2026</div>`;
    pollSmartFoldersProgress(d.slug);
  } else if (sfStatus === "complete") {
    sfEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge ok">Complete</span>
      </div>
      <div id="sf-summary" class="muted small" style="margin-top:8px;">Loading summary\u2026</div>
      <div class="btn-row">
        <button class="danger-outline" id="btn-unwind-sf">Unwind</button>
      </div>`;
    loadSmartFoldersSummary(d.slug);
    $("#btn-unwind-sf")?.addEventListener("click", () => unwindSmartFolders(d.slug));
  } else if (sfStatus === "skipped") {
    sfEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge">Skipped</span>
      </div>
      <p class="muted small" style="margin:8px 0 0;">
        Skipped. Indexing will use mechanical filters only.
      </p>`;
  } else if (sfStatus === "errored") {
    sfEl.innerHTML = `
      <div class="domain-stat-row">
        <span class="domain-stat-label">Status</span>
        <span class="badge" style="color:var(--err);border-color:#7f1d1d;">Errored</span>
      </div>
      <p class="muted small" style="margin:8px 0 0;color:var(--err);">
        ${escapeHtml(lc.smart_folders?.error || "Unknown error")}
      </p>
      <div class="btn-row">
        <button class="primary" id="btn-retry-sf">Retry</button>
        <button class="secondary" id="btn-skip-sf-err">Skip</button>
      </div>`;
    $("#btn-retry-sf")?.addEventListener("click", () => startSmartFolders(d.slug));
    $("#btn-skip-sf-err")?.addEventListener("click", () => skipSmartFolders(d.slug));
  }
}

async function startSmartFolders(slug) {
  const btn = $("#btn-start-sf") || $("#btn-retry-sf");
  if (btn) { btn.disabled = true; btn.textContent = "Starting\u2026"; }
  try {
    await api("POST", `/api/domains/${encodeURIComponent(slug)}/smart-folders/start`);
    flash("Smart Folders started.");
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

async function skipSmartFolders(slug) {
  try {
    await api("POST", `/api/domains/${encodeURIComponent(slug)}/smart-folders/skip`);
    flash("Smart Folders skipped.");
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

async function unwindSmartFolders(slug) {
  if (!confirm(`Unwind Smart Folders for "${slug}"?\n\nThis will reverse all file moves and reset indexing state. Files added after Smart Folders ran are preserved.`)) return;
  const btn = $("#btn-unwind-sf");
  if (btn) { btn.disabled = true; btn.textContent = "Unwinding\u2026"; }
  try {
    const r = await api("POST", `/api/domains/${encodeURIComponent(slug)}/smart-folders/unwind`);
    alert(`Unwound ${r.reversed} moves.\n${r.skipped.length ? `${r.skipped.length} moves could not be reversed (see details in response).` : ""}`);
    await showDomainPage(slug);
  } catch (err) { alert(err.message); }
}

let sfPollTimer = null;
function clearSmartFoldersTimer() {
  if (sfPollTimer) { clearInterval(sfPollTimer); sfPollTimer = null; }
}
function pollSmartFoldersProgress(slug) {
  clearSmartFoldersTimer();
  async function poll() {
    try {
      const p = await api("GET", `/api/domains/${encodeURIComponent(slug)}/smart-folders/progress`);
      const area = $("#sf-progress-area");
      if (!area) { clearInterval(sfPollTimer); return; }

      if (p.phase === "complete") {
        clearInterval(sfPollTimer);
        await showDomainPage(slug);
        return;
      }
      if (p.phase === "errored") {
        clearInterval(sfPollTimer);
        await showDomainPage(slug);
        return;
      }

      const phases = {
        scanning: "Scanning files\u2026",
        proposing_structure: "Proposing folder structure\u2026",
        placing_files: `Placing files (batch ${p.current_batch || "?"}/${p.total_batches || "?"})\u2026`,
        moving: "Moving files\u2026",
      };
      area.textContent = `${phases[p.phase] || p.phase} \u2014 ${p.done_files}/${p.total_files} files`;
    } catch { /* ignore poll errors */ }
  }
  poll();
  sfPollTimer = setInterval(poll, 3000);
}

async function loadSmartFoldersSummary(slug) {
  try {
    const data = await api("GET", `/api/domains/${encodeURIComponent(slug)}/smart-folders/triage`);
    const s = data.summary || {};
    const el = $("#sf-summary");
    if (el) {
      el.textContent = [
        `${s.files_scanned || 0} scanned`,
        `${s.files_moved || 0} moved`,
        `${s.files_kept || 0} kept`,
        `${s.files_skipped || 0} skipped`,
        `${s.files_deferred || 0} deferred`,
      ].join(" \u00b7 ");
    }
  } catch { /* ignore */ }
}

async function loadTriageTable(slug) {
  const body = $("#domain-triage-body");
  if (!body) return;
  body.textContent = "Loading\u2026";
  try {
    const data = await api("GET", `/api/domains/${encodeURIComponent(slug)}/smart-folders/triage`);
    const triage = data.triage || {};
    const entries = Object.entries(triage);
    if (!entries.length) {
      body.innerHTML = '<div class="muted small">No triage data.</div>';
      return;
    }
    // Sort: skip first, then defer, then keep
    const order = { skip: 0, defer: 1, keep: 2 };
    entries.sort((a, b) => (order[a[1].verdict] || 9) - (order[b[1].verdict] || 9));

    // Show first 200 entries
    const shown = entries.slice(0, 200);
    let html = '<div style="overflow-x:auto;"><table style="width:100%;font-size:13px;border-collapse:collapse;">';
    html += '<tr style="text-align:left;border-bottom:1px solid var(--border);"><th style="padding:6px;">File</th><th style="padding:6px;">Verdict</th><th style="padding:6px;">Reason</th><th style="padding:6px;">Override</th></tr>';
    for (const [file, v] of shown) {
      const badgeClass = v.verdict === "keep" ? "ok" : v.verdict === "skip" ? "" : "warn";
      html += `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:6px;word-break:break-all;max-width:300px;">${escapeHtml(file)}</td>
        <td style="padding:6px;"><span class="badge ${badgeClass}">${escapeHtml(v.verdict)}</span></td>
        <td style="padding:6px;color:var(--muted);">${escapeHtml(v.reason || "")}</td>
        <td style="padding:6px;">
          <select data-triage-file="${escapeHtml(file)}" data-triage-slug="${escapeHtml(slug)}" style="font-size:12px;padding:2px 6px;min-height:auto;">
            <option value="">—</option>
            <option value="keep" ${v.verdict === "keep" ? "selected" : ""}>keep</option>
            <option value="skip" ${v.verdict === "skip" ? "selected" : ""}>skip</option>
            <option value="defer" ${v.verdict === "defer" ? "selected" : ""}>defer</option>
          </select>
        </td>
      </tr>`;
    }
    html += "</table></div>";
    if (entries.length > 200) {
      html += `<div class="muted small" style="margin-top:8px;">Showing ${shown.length} of ${entries.length} files.</div>`;
    }
    body.innerHTML = html;

    // Wire up override selects
    body.querySelectorAll("[data-triage-file]").forEach((sel) =>
      sel.addEventListener("change", async () => {
        const file = sel.dataset.triageFile;
        const s = sel.dataset.triageSlug;
        const verdict = sel.value;
        if (!verdict) return;
        try {
          await api("PATCH", `/api/domains/${encodeURIComponent(s)}/smart-folders/triage`, { file, verdict });
          flash("Override saved.");
        } catch (err) { alert(err.message); }
      }),
    );
  } catch (err) {
    body.textContent = err.message;
  }
}

$("#domain-back")?.addEventListener("click", () => {
  domainPageSlug = null;
  clearSmartFoldersTimer();
  // Return to previous tab
  const btn = $(`#tabs button[data-tab="${domainPreviousTab}"]`);
  if (btn) btn.click();
  else $(`#tabs button[data-tab="home"]`)?.click();
});

// ------ misc ------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function flash(msg) {
  const pill = $("#status-pill");
  const prev = pill.textContent, prevClass = pill.className;
  pill.textContent = msg;
  pill.className = "status-pill ok";
  setTimeout(() => { pill.textContent = prev; pill.className = prevClass; }, 1500);
}

// ------ init ------
initTabs();
initSettingsNav();
loadDomains();
loadHome();
refreshSetup();
setInterval(loadHome, 5000);

// If we're landing on the Gmail callback's redirect (/#settings?gmail=ok&msg=...),
// jump straight to the Settings tab and surface the result.
(function handleGmailCallbackLanding() {
  const hash = window.location.hash || "";
  const match = hash.match(/^#settings\?(.+)$/);
  if (!match) return;
  const params = new URLSearchParams(match[1]);
  const gmail = params.get("gmail");
  const msg = params.get("msg") || "";
  if (!gmail) return;
  // Show Settings tab
  $(`#tabs button[data-tab="settings"]`)?.click();
  // Jump to Channels sub-tab where the Gmail card lives
  $(`#settings-nav button[data-stab="channels"]`)?.click();
  if (gmail === "ok") flash(msg || "Gmail connected.");
  else alert("Gmail connection failed: " + msg);
  // Clean URL
  history.replaceState(null, "", "/#settings");
  setTimeout(refreshGmailStatus, 300);
})();

// =========================================================================
// CHAT TAB — user's private LM Studio playground
// Walled off from Sarah: nothing written here is visible to her, and her
// operator manual explicitly forbids touching playground/.
// =========================================================================

const chatState = {
  chats: [],          // list from /api/playground/chats
  presets: [],        // list from /api/playground/presets
  models: [],         // list from /api/playground/models
  currentChatId: null,
  currentMeta: null,
  messages: [],
  attachedImages: [], // {dataUrl, name} pending for next send
  streaming: false,
};

async function loadChatTab() {
  try {
    const [chatsRes, presetsRes, modelsRes] = await Promise.all([
      api("GET", "/api/playground/chats"),
      api("GET", "/api/playground/presets"),
      api("GET", "/api/playground/models").catch(() => ({ models: [] })),
    ]);
    chatState.chats = chatsRes.chats || [];
    chatState.presets = presetsRes.presets || [];
    chatState.models = modelsRes.models || [];
    renderChatList();
    renderPresetDropdown();
    renderModelDropdown();
  } catch (err) {
    alert("Failed to load chat data: " + err.message);
  }
}

function renderChatList() {
  const host = $("#chat-list");
  if (!host) return;
  if (chatState.chats.length === 0) {
    host.innerHTML = '<div class="chat-list-group">No chats yet</div>';
    return;
  }
  const groups = groupChatsByRecency(chatState.chats);
  host.innerHTML = "";
  for (const g of groups) {
    const header = document.createElement("div");
    header.className = "chat-list-group";
    header.textContent = g.label;
    host.appendChild(header);
    for (const c of g.chats) {
      const item = document.createElement("div");
      item.className = "chat-list-item";
      if (c.id === chatState.currentChatId) item.classList.add("active");
      item.innerHTML = `
        <span class="chat-item-title">${escapeHtml(c.title)}</span>
        <button class="chat-item-del" title="Delete">✕</button>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("chat-item-del")) return;
        openChat(c.id);
      });
      item.querySelector(".chat-item-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete chat "${c.title}"?`)) return;
        await api("DELETE", "/api/playground/chats/" + encodeURIComponent(c.id));
        if (chatState.currentChatId === c.id) {
          chatState.currentChatId = null;
          chatState.currentMeta = null;
          chatState.messages = [];
          renderMessages();
        }
        await loadChatTab();
      });
      host.appendChild(item);
    }
  }
}

function groupChatsByRecency(chats) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const ydate = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const buckets = { today: [], yesterday: [], week: [], older: [] };
  for (const c of chats) {
    const d = c.updated_at.slice(0, 10);
    if (d === today) buckets.today.push(c);
    else if (d === ydate) buckets.yesterday.push(c);
    else if (d > weekAgo) buckets.week.push(c);
    else buckets.older.push(c);
  }
  const groups = [];
  if (buckets.today.length) groups.push({ label: "Today", chats: buckets.today });
  if (buckets.yesterday.length) groups.push({ label: "Yesterday", chats: buckets.yesterday });
  if (buckets.week.length) groups.push({ label: "This week", chats: buckets.week });
  if (buckets.older.length) groups.push({ label: "Older", chats: buckets.older });
  return groups;
}

function renderPresetDropdown() {
  const sel = $("#chat-preset");
  if (!sel) return;
  sel.innerHTML = '<option value="">No preset</option>';
  for (const p of chatState.presets) {
    const opt = document.createElement("option");
    opt.value = p.slug;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  // If current chat has a preset, select it
  if (chatState.currentMeta?.preset) sel.value = chatState.currentMeta.preset;
}

function renderModelDropdown() {
  const sel = $("#chat-model");
  if (!sel) return;
  sel.innerHTML = "";
  if (chatState.models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(LM Studio unreachable)";
    sel.appendChild(opt);
    return;
  }
  for (const m of chatState.models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  if (chatState.currentMeta?.model) sel.value = chatState.currentMeta.model;
}

async function openChat(id) {
  try {
    const r = await api("GET", "/api/playground/chats/" + encodeURIComponent(id));
    chatState.currentChatId = id;
    chatState.currentMeta = r.meta;
    chatState.messages = r.messages || [];
    $("#chat-title").textContent = r.meta.title;
    $("#chat-model").value = r.meta.model || "";
    $("#chat-preset").value = r.meta.preset || "";
    renderMessages();
    renderChatList();
  } catch (err) {
    alert("Could not open chat: " + err.message);
  }
}

function renderMessages() {
  const host = $("#chat-messages");
  if (!host) return;
  if (chatState.messages.length === 0) {
    if (chatState.currentChatId) {
      host.innerHTML = '<div class="chat-empty muted">Say something to start this chat.</div>';
    } else {
      host.innerHTML = '<div class="chat-empty muted">Pick a chat or start a new one.</div>';
    }
    return;
  }
  host.innerHTML = "";
  for (const m of chatState.messages) {
    const el = renderMessageElement(m);
    host.appendChild(el);
  }
  host.scrollTop = host.scrollHeight;
}

function renderMessageElement(m) {
  const el = document.createElement("div");
  el.className = "chat-msg " + m.role;
  if (typeof m.content === "string") {
    el.innerHTML = renderMessageText(m.content);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part.type === "text" && part.text) {
        const t = document.createElement("div");
        t.innerHTML = renderMessageText(part.text);
        el.appendChild(t);
      } else if (part.type === "image_url" && part.image_url?.url) {
        const img = document.createElement("img");
        img.src = part.image_url.url;
        el.appendChild(img);
      }
    }
  }
  return el;
}

// Very light markdown-ish rendering: code fences + inline code + preserve newlines.
function renderMessageText(text) {
  // Escape first
  let s = escapeHtml(text);
  // Code fences ```lang\n...\n```
  s = s.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code}</code></pre>`
  );
  // Inline `code`
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}

async function newChat() {
  const preset = $("#chat-preset").value || null;
  const model = $("#chat-model").value;
  if (!model) {
    alert("Pick a model first (LM Studio may be offline).");
    return;
  }
  try {
    const meta = await api("POST", "/api/playground/chats", {
      title: "New chat",
      preset,
      model,
    });
    chatState.currentChatId = meta.id;
    chatState.currentMeta = meta;
    chatState.messages = [];
    await loadChatTab();
    $("#chat-title").textContent = meta.title;
    renderMessages();
    $("#chat-input").focus();
  } catch (err) {
    alert("Could not create chat: " + err.message);
  }
}

async function sendChatMessage() {
  if (chatState.streaming) return;
  const input = $("#chat-input");
  const text = input.value.trim();
  const images = chatState.attachedImages.map((a) => a.dataUrl);
  if (!text && images.length === 0) return;

  // Ensure we have a chat to send to
  if (!chatState.currentChatId) await newChat();
  if (!chatState.currentChatId) return;

  // Optimistically render the user's message
  const userMsg = {
    role: "user",
    content: images.length > 0
      ? [
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((du) => ({ type: "image_url", image_url: { url: du } })),
        ]
      : text,
  };
  chatState.messages.push(userMsg);
  renderMessages();
  input.value = "";
  chatState.attachedImages = [];
  renderAttachedImages();

  // Placeholder assistant message we'll stream into
  const assistantMsg = { role: "assistant", content: "" };
  chatState.messages.push(assistantMsg);
  const msgsHost = $("#chat-messages");
  const placeholder = renderMessageElement(assistantMsg);
  placeholder.classList.add("streaming");
  msgsHost.appendChild(placeholder);
  msgsHost.scrollTop = msgsHost.scrollHeight;

  chatState.streaming = true;
  $("#chat-send").disabled = true;

  try {
    const res = await fetch(
      "/api/playground/chats/" + encodeURIComponent(chatState.currentChatId) + "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images }),
      }
    );
    if (!res.ok || !res.body) {
      placeholder.innerHTML = renderMessageText("(error: " + res.status + ")");
      placeholder.classList.remove("streaming");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Parse SSE blocks (event: xxx\ndata: yyy\n\n)
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const { event, data } = parseSSEBlock(block);
        if (!data) continue;
        try {
          const payload = JSON.parse(data);
          if (event === "delta" && payload.delta) {
            fullText += payload.delta;
            placeholder.innerHTML = renderMessageText(fullText);
            msgsHost.scrollTop = msgsHost.scrollHeight;
          } else if (event === "title" && payload.title) {
            $("#chat-title").textContent = payload.title;
            if (chatState.currentMeta) chatState.currentMeta.title = payload.title;
          } else if (event === "error") {
            placeholder.innerHTML = renderMessageText(
              "(error: " + (payload.message || "unknown") + ")"
            );
          } else if (event === "done") {
            assistantMsg.content = fullText;
          }
        } catch { /* ignore malformed */ }
      }
    }
    placeholder.classList.remove("streaming");
    // Refresh chat list to update ordering / title
    await refreshChatListOnly();
  } catch (err) {
    placeholder.innerHTML = renderMessageText("(network error: " + err.message + ")");
    placeholder.classList.remove("streaming");
  } finally {
    chatState.streaming = false;
    $("#chat-send").disabled = false;
    input.focus();
  }
}

function parseSSEBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
  }
  return { event, data };
}

async function refreshChatListOnly() {
  try {
    const r = await api("GET", "/api/playground/chats");
    chatState.chats = r.chats || [];
    renderChatList();
  } catch { /* ignore */ }
}

function renderAttachedImages() {
  const host = $("#chat-attached-images");
  if (!host) return;
  host.innerHTML = "";
  chatState.attachedImages.forEach((a, i) => {
    const wrap = document.createElement("div");
    wrap.className = "chat-attached-item";
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.title = a.name;
    const x = document.createElement("span");
    x.className = "chat-attached-x";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      chatState.attachedImages.splice(i, 1);
      renderAttachedImages();
    });
    wrap.appendChild(img);
    wrap.appendChild(x);
    host.appendChild(wrap);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---- Preset editor modal ----
let editingPresetSlug = null; // null = creating new
function openPresetEditor(slug) {
  editingPresetSlug = slug;
  const preset = slug ? chatState.presets.find((p) => p.slug === slug) : null;
  $("#chat-preset-modal-title").textContent = preset ? "Edit preset" : "New preset";
  $("#chat-preset-slug").value = preset?.slug || "";
  $("#chat-preset-slug").disabled = !!preset;
  $("#chat-preset-name").value = preset?.name || "";
  $("#chat-preset-model").value = preset?.model || ($("#chat-model").value || "");
  $("#chat-preset-temp").value = preset?.temperature ?? "";
  $("#chat-preset-maxtok").value = preset?.max_tokens ?? "";
  $("#chat-preset-prompt").value = preset?.system_prompt || "";
  $("#chat-preset-delete").classList.toggle("hidden", !preset);
  $("#chat-preset-error").classList.add("hidden");
  $("#chat-preset-modal").classList.remove("hidden");
  $("#chat-preset-modal").setAttribute("aria-hidden", "false");
  document.body.classList.add("wizard-modal-open");
}
function closePresetEditor() {
  $("#chat-preset-modal").classList.add("hidden");
  $("#chat-preset-modal").setAttribute("aria-hidden", "true");
  document.body.classList.remove("wizard-modal-open");
}

async function savePresetFromEditor() {
  const slug = $("#chat-preset-slug").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const name = $("#chat-preset-name").value.trim();
  const model = $("#chat-preset-model").value.trim();
  const temp = parseFloat($("#chat-preset-temp").value);
  const maxTok = parseInt($("#chat-preset-maxtok").value, 10);
  const prompt = $("#chat-preset-prompt").value;
  if (!slug || !name || !model) {
    const err = $("#chat-preset-error");
    err.textContent = "Slug, name, and model are required.";
    err.classList.remove("hidden");
    return;
  }
  const body = {
    name,
    model,
    temperature: isFinite(temp) ? temp : undefined,
    max_tokens: isFinite(maxTok) ? maxTok : undefined,
    system_prompt: prompt,
  };
  const savedSlug = editingPresetSlug ?? slug;
  try {
    if (editingPresetSlug) {
      await api("PUT", "/api/playground/presets/" + encodeURIComponent(editingPresetSlug), body);
    } else {
      await api("POST", "/api/playground/presets", { slug, ...body });
    }
    closePresetEditor();
    await loadChatTab();
    // Auto-select the preset we just saved so the user sees it's active.
    const sel = $("#chat-preset");
    if (sel) sel.value = savedSlug;
    flash(`Saved preset: ${name}`);
  } catch (err) {
    const e = $("#chat-preset-error");
    e.textContent = err.message;
    e.classList.remove("hidden");
  }
}

async function deletePresetFromEditor() {
  if (!editingPresetSlug) return;
  if (!confirm("Delete this preset? Chats already using it keep their copy of the prompt.")) return;
  await api("DELETE", "/api/playground/presets/" + encodeURIComponent(editingPresetSlug));
  closePresetEditor();
  await loadChatTab();
}

// ---- Event wiring ----
$("#chat-new-btn")?.addEventListener("click", newChat);
$("#chat-send")?.addEventListener("click", sendChatMessage);
$("#chat-input")?.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});
$("#chat-image-input")?.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  for (const f of files) {
    try {
      const dataUrl = await readFileAsDataUrl(f);
      chatState.attachedImages.push({ dataUrl, name: f.name });
    } catch { /* skip */ }
  }
  e.target.value = ""; // reset so same file can be picked again
  renderAttachedImages();
});
$("#chat-edit-preset")?.addEventListener("click", () => {
  const cur = $("#chat-preset").value;
  if (!cur) {
    alert('Select a preset from the dropdown to edit it, or click "+ New preset" to create a new one.');
    return;
  }
  openPresetEditor(cur);
});
$("#chat-new-preset")?.addEventListener("click", () => {
  openPresetEditor(null);
});
$("#chat-preset-cancel")?.addEventListener("click", closePresetEditor);
$("#chat-preset-save")?.addEventListener("click", savePresetFromEditor);
$("#chat-preset-delete")?.addEventListener("click", deletePresetFromEditor);

// Tab-switch hook for "chat" is wired directly into onTabShown() above.

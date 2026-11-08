/* Sherlock WebUI frontend — vanilla JS, no external dependencies. */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  current: localStorage.getItem("sherlock.currentJob") || null,
  showFoundOnly: false,
  lastRendered: null, // serialize result of the current job
};

const STATUS_LABELS = {
  queued: "排队中",
  running: "侦查中",
  done: "已完成",
  error: "失败",
};

const RESULT_LABELS = {
  Claimed: "已命中",
  Available: "未注册",
  Unknown: "未知",
  Illegal: "格式不符",
  WAF: "被拦截",
};

/* ---------- helpers ---------- */

async function api(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* keep default */ }
    throw new Error(detail);
  }
  return resp.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(statusText, map) {
  const node = el("span", "chip", (map && map[statusText]) || statusText);
  node.classList.add(String(statusText).toLowerCase());
  return node;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("zh-CN", { hour12: false });
}

function fmtElapsed(job) {
  if (job.elapsed_s != null) return `${job.elapsed_s}s`;
  if (job.status === "running" && job.started) {
    const sec = Math.max(0, Math.round((Date.now() - Date.parse(job.started)) / 1000));
    return `${sec}s`;
  }
  return "";
}

/* ---------- rendering ---------- */

function renderJobCard(job) {
  $("job-card").hidden = false;
  $("job-username").textContent = job.username;

  const statusChip = chip(job.status, STATUS_LABELS);
  const statusSlot = $("job-status");
  statusSlot.replaceWith(statusChip);
  statusChip.id = "job-status";

  const total = job.total || 0;
  const pct = total ? Math.round((job.completed / total) * 100) : 0;
  $("job-fill").style.width = `${pct}%`;
  $("job-progress-text").textContent = `进度 ${job.completed}/${total}（${pct}%）`;
  $("job-elapsed").textContent = fmtTime(job.started) ? `开始于 ${fmtTime(job.started)}` : "";

  $("job-found").innerHTML = "";
  const foundLine = $("job-found");
  foundLine.append("命中 ");
  foundLine.append(el("strong", null, String(job.found)));
  foundLine.append(` / ${total} 个站点`);

  const actions = $("job-actions");
  actions.innerHTML = "";
  if (job.status === "done" && job.files) {
    for (const [kind, label] of [["json", "JSON"], ["csv", "CSV"], ["txt", "TXT"]]) {
      if (job.files[kind]) {
        const a = el("a", "btn btn-secondary", `下载 ${label}`);
        a.href = `/api/results/${encodeURIComponent(job.files[kind])}`;
        a.setAttribute("download", job.files[kind]);
        actions.append(a);
      }
    }
  }
  const rerun = el("button", "btn btn-secondary", "重新侦查");
  rerun.type = "button";
  rerun.addEventListener("click", () => {
    $("username").value = job.username;
    $("search-form").requestSubmit();
  });
  actions.append(rerun);

  const jobError = $("job-error");
  if (job.status === "error" && job.error) {
    jobError.textContent = `任务失败：${job.error}`;
    jobError.hidden = false;
  } else {
    jobError.hidden = true;
  }

  renderResultsTable(job);
}

function renderResultsTable(job) {
  const tbody = $("results-body");
  tbody.innerHTML = "";
  const results = (job.results || []).filter(
    (r) => !state.showFoundOnly || r.status === "Claimed"
  );
  $("results-empty").hidden = results.length > 0;
  for (const r of results) {
    const tr = el("tr");

    const tdStatus = el("td");
    tdStatus.append(chip(r.status, RESULT_LABELS));
    tr.append(tdStatus);

    tr.append(el("td", "site-name", r.site));

    const tdLink = el("td");
    if (r.status === "Claimed" && r.url_user) {
      const a = el("a", null, r.url_user);
      a.href = r.url_user;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      tdLink.append(a);
    } else if (r.url_user) {
      tdLink.append(el("span", "ctx", r.url_user));
    }
    tr.append(tdLink);

    tr.append(el("td", null, r.query_time != null ? `${Math.round(r.query_time * 1000)}ms` : "—"));

    tr.append(el("td", "ctx", r.context || ""));
    tbody.append(tr);
  }
}

function renderHistory(jobs) {
  const list = $("history-list");
  list.innerHTML = "";
  $("history-empty").hidden = jobs.length > 0;
  for (const job of jobs) {
    const li = el("li");
    li.addEventListener("click", () => {
      state.current = job.id;
      localStorage.setItem("sherlock.currentJob", job.id);
      refresh();
    });

    li.append(el("span", "h-username", job.username));
    const meta = el("span", "h-meta");
    meta.append(chip(job.status, STATUS_LABELS));
    meta.append(el("span", "muted", `命中 ${job.found}/${job.total}`));
    if (job.elapsed_s != null) meta.append(el("span", "muted", `${job.elapsed_s}s`));
    meta.append(el("span", "muted", fmtTime(job.created)));
    li.append(meta);
    list.append(li);
  }
}

/* ---------- data refresh ---------- */

async function refresh() {
  try {
    const jobs = await api("/api/jobs");
    renderHistory(jobs);
    if (state.current) {
      const exists = jobs.some((j) => j.id === state.current);
      if (!exists) {
        state.current = null;
        localStorage.removeItem("sherlock.currentJob");
      } else {
        const detail = await api(`/api/jobs/${state.current}`);
        state.lastRendered = detail;
        renderJobCard(detail);
      }
    }
    $("error").hidden = true;
  } catch (err) {
    showError(err.message);
  }
}

function showError(message) {
  const box = $("error");
  box.textContent = message;
  box.hidden = false;
}

/* ---------- events ---------- */

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("btn-search");
  const username = $("username").value.trim();
  if (!username) return;

  const sites = $("sites").value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    username,
    timeout: Number($("timeout").value) || 15,
    nsfw: $("nsfw").checked,
    sites,
  };

  btn.disabled = true;
  try {
    const job = await api("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.current = job.id;
    localStorage.setItem("sherlock.currentJob", job.id);
    $("job-card").hidden = false;
    $("results-body").innerHTML = "";
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("found-only").addEventListener("change", (event) => {
  state.showFoundOnly = event.target.checked;
  if (state.lastRendered) renderResultsTable(state.lastRendered);
});

async function checkHealth() {
  const dot = $("health-dot");
  try {
    await api("/healthz");
    dot.className = "dot ok";
  } catch (_) {
    dot.className = "dot bad";
  }
}

async function loadSiteCount() {
  try {
    const data = await api("/api/sites");
    $("sites-count").textContent = `已收录 ${data.count} 个站点`;
  } catch (_) {
    $("sites-count").textContent = "站点清单加载失败";
  }
}

/* ---------- boot ---------- */

(async function init() {
  await checkHealth();
  loadSiteCount();
  await refresh();
  setInterval(refresh, 2000);
  setInterval(checkHealth, 30000);
})();

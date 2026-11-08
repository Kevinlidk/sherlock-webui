/* Sherlock WebUI frontend — vanilla JS, no external dependencies.
 *
 * History lives in the browser (localStorage), not on the server: the page
 * keeps up to HISTORY_MAX recent jobs locally and only talks to the server
 * for the currently opened job's detail. After a container restart old
 * details are gone from server memory, so cached entries degrade gracefully
 * to their last-known state with a notice.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const HISTORY_KEY = "sherlock.history";
const CURRENT_KEY = "sherlock.currentJob";
const HISTORY_MAX = 20;

const state = {
  current: localStorage.getItem(CURRENT_KEY) || null,
  showFoundOnly: false,
  lastRendered: null, // last rendered job object (detail or cached summary)
};

const STATUS_LABELS = {
  queued: "排队中",
  running: "侦查中",
  done: "已完成",
  error: "失败",
  expired: "已过期",
};

const RESULT_LABELS = {
  Claimed: "已命中",
  Available: "未注册",
  Unknown: "未知",
  Illegal: "格式不符",
  WAF: "被拦截",
};

/* ---------- localStorage history ---------- */

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch (_) { /* storage full/blocked — history is best-effort */ }
}

function historyEntryFromJob(job) {
  return {
    id: job.id,
    username: job.username,
    created: job.created,
    started: job.started ?? null,
    status: job.status,
    found: job.found ?? 0,
    total: job.total ?? null,
    completed: job.completed ?? null,
    elapsed_s: job.elapsed_s ?? null,
    files: job.files || {},
  };
}

function upsertHistoryEntry(entry) {
  const list = loadHistory().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  saveHistory(list);
}

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
  const completed = job.completed != null ? job.completed : null;
  const pctShown = total && completed != null ? Math.round((completed / total) * 100) : 0;
  $("job-fill").style.width = `${pctShown}%`;
  $("job-progress-text").textContent = completed != null
    ? `进度 ${completed}/${total}（${pctShown}%）`
    : `已收录 ${total} 个站点`;
  $("job-elapsed").textContent = fmtTime(job.started) ? `开始于 ${fmtTime(job.started)}` : "";

  const foundLine = $("job-found");
  foundLine.innerHTML = "";
  foundLine.append("命中 ");
  foundLine.append(el("strong", null, String(job.found ?? 0)));
  if (total) foundLine.append(` / ${total} 个站点`);

  const actions = $("job-actions");
  actions.innerHTML = "";
  if (job.files) {
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
  if (job.expired) {
    jobError.textContent =
      "该任务详情已不在服务端内存中（容器重启后任务队列清空）。" +
      "结果文件在挂载了结果卷时仍可下载，或点击“重新侦查”重新扫描。";
    jobError.hidden = false;
  } else if (job.status === "error" && job.error) {
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

function renderHistory() {
  const list = loadHistory();
  const container = $("history-list");
  container.innerHTML = "";
  $("history-empty").hidden = list.length > 0;
  for (const entry of list) {
    const li = el("li");
    li.addEventListener("click", () => selectJob(entry.id));

    li.append(el("span", "h-username", entry.username));
    const meta = el("span", "h-meta");
    meta.append(chip(entry.status, STATUS_LABELS));
    if (entry.total != null) {
      meta.append(el("span", "muted", `命中 ${entry.found ?? 0}/${entry.total}`));
    }
    if (entry.elapsed_s != null) meta.append(el("span", "muted", `${entry.elapsed_s}s`));
    meta.append(el("span", "muted", fmtTime(entry.created)));
    li.append(meta);

    const del = el("button", "btn btn-secondary h-delete", "✕");
    del.type = "button";
    del.title = "从本地历史移除";
    del.setAttribute("aria-label", `移除 ${entry.username} 的历史记录`);
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      saveHistory(loadHistory().filter((x) => x.id !== entry.id));
      if (state.current === entry.id) {
        state.current = null;
        state.lastRendered = null;
        localStorage.removeItem(CURRENT_KEY);
        $("job-card").hidden = true;
      }
      renderHistory();
    });
    li.append(del);
    container.append(li);
  }
}

/* ---------- data refresh ---------- */

async function pollCurrent(force = false) {
  if (!state.current) return;
  const last = state.lastRendered;
  // details are immutable once finished — skip re-fetching finished jobs
  if (!force && last && (last.status === "done" || last.status === "error")) return;
  try {
    const detail = await api(`/api/jobs/${state.current}`);
    state.lastRendered = detail;
    renderJobCard(detail);
    upsertHistoryEntry(historyEntryFromJob(detail));
    renderHistory();
  } catch (err) {
    if (state.lastRendered && /404|任务不存在/.test(err.message)) {
      // server lost the job (restart/prune): degrade to the cached summary
      const cached = { ...state.lastRendered, results: [], expired: true };
      state.lastRendered = cached;
      renderJobCard(cached);
    } else {
      showError(err.message);
    }
  }
}

async function selectJob(id) {
  state.current = id;
  localStorage.setItem(CURRENT_KEY, id);
  const cached = loadHistory().find((e) => e.id === id);
  if (cached) {
    // provisional render from local cache, replaced by live detail if available
    state.lastRendered = { ...cached, results: [] };
    renderJobCard(state.lastRendered);
  }
  await pollCurrent(true);
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
    localStorage.setItem(CURRENT_KEY, job.id);
    state.lastRendered = { ...job, results: [] };
    renderJobCard(state.lastRendered);
    upsertHistoryEntry(historyEntryFromJob(job));
    renderHistory();
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

$("clear-history").addEventListener("click", () => {
  saveHistory([]);
  renderHistory();
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
  renderHistory();
  if (state.current) selectJob(state.current);
  setInterval(() => pollCurrent(false), 2000);
  setInterval(checkHealth, 30000);
})();

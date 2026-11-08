"""Job runner for Sherlock WebUI.

Wraps the ``sherlock_project`` library in a small in-process job manager:

* each search runs on its own daemon thread (bounded by a semaphore),
* per-site results stream in live through a custom ``QueryNotify`` collector,
* finished jobs export JSON / CSV / TXT files into ``RESULTS_DIR``.

The site manifest comes from the ``data.json`` bundled inside the
``sherlock-project`` package, so the container works fully offline. The
upstream false-positive exclusion list is fetched once and cached; when the
network is unavailable the scan simply proceeds without exclusions (same
graceful behavior as the sherlock CLI).
"""

from __future__ import annotations

import copy
import csv
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sherlock_project
from sherlock_project.notify import QueryNotify
from sherlock_project.result import QueryResult
from sherlock_project.sherlock import sherlock
from sherlock_project.sites import SitesInformation

RESULTS_DIR = Path(
    os.environ.get("SHERLOCK_RESULTS_DIR", "/opt/sherlock/results")
).resolve()
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

MAX_CONCURRENT = max(1, int(os.environ.get("SHERLOCK_MAX_CONCURRENT", "2")))
PROXY = os.environ.get("SHERLOCK_PROXY") or None
HISTORY_LIMIT = max(1, int(os.environ.get("SHERLOCK_HISTORY_LIMIT", "100")))

LOCAL_DATA_JSON = Path(sherlock_project.__file__).parent / "resources" / "data.json"
EXCLUSIONS_SNAPSHOT = Path(__file__).parent / "resources" / "false_positive_exclusions.txt"

_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]")
# Export files are flat names directly inside RESULTS_DIR.
_RESULT_FILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_FOUND = "Claimed"

_sem = threading.BoundedSemaphore(MAX_CONCURRENT)
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

_site_names: list[str] | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _get_exclusions() -> list[str]:
    """Load the vendored false-positive exclusion snapshot.

    The snapshot (app/resources/false_positive_exclusions.txt) is refreshed
    manually at development time — see README — and shipped with the image;
    the runtime server performs no server-initiated HTTP requests at all.
    """
    try:
        lines = EXCLUSIONS_SNAPSHOT.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if line.strip()]


def site_names() -> list[str]:
    """All site names known to the bundled manifest (cached)."""
    global _site_names
    with _lock:
        if _site_names is None:
            sites = SitesInformation(str(LOCAL_DATA_JSON), honor_exclusions=False)
            _site_names = sites.site_name_list()
        return list(_site_names)


def load_site_data(
    nsfw: bool = False, site_filter: list[str] | None = None
) -> dict[str, dict[str, Any]]:
    """Build a fresh site manifest for one job.

    NSFW sites are removed unless ``nsfw`` is set (mirroring the CLI flag).
    When the caller narrows the scan to specific sites, exclusions and NSFW
    removal skip those sites — same semantics as the CLI ``--site`` option.
    """
    sites = SitesInformation(str(LOCAL_DATA_JSON), honor_exclusions=False)
    keep = {name.strip().casefold() for name in (site_filter or []) if name.strip()}
    if not nsfw:
        sites.remove_nsfw_sites(
            do_not_remove=[name for name in sites.sites if name.casefold() in keep]
        )
    data = {site.name: site.information for site in sites}
    if keep:
        data = {name: info for name, info in data.items() if name.casefold() in keep}
    else:
        for name in _get_exclusions():
            data.pop(name, None)
    return data


class _Collector(QueryNotify):
    """Thread-safe ``QueryNotify`` that appends serialized results to a job."""

    def __init__(self, job: dict[str, Any]) -> None:
        super().__init__(None)
        self._job = job

    def update(self, result: QueryResult) -> None:  # type: ignore[override]
        entry = {
            "site": result.site_name,
            "url_user": result.site_url_user,
            "status": str(result.status),
            "query_time": (
                round(result.query_time, 3) if result.query_time is not None else None
            ),
            "context": result.context,
        }
        with _lock:
            self._job["results"].append(entry)
            self._job["completed"] = len(self._job["results"])


def _safe_stem(username: str, job_id: str) -> str:
    stem = _FILENAME_SAFE.sub("_", username)[:48].strip("._-") or "user"
    return f"{stem}_{job_id[:8]}"


def result_file_path(name: str) -> Path:
    """Resolve a result filename, refusing anything outside RESULTS_DIR.

    Single guard shared by the export writer and the download endpoint:
    only flat ``[A-Za-z0-9._-]`` names directly inside RESULTS_DIR pass.
    """
    if not _RESULT_FILE_RE.fullmatch(name):
        raise ValueError(f"非法结果文件名: {name!r}")
    path = (RESULTS_DIR / name).resolve()
    if path.parent != RESULTS_DIR:
        raise ValueError("结果路径越界")
    return path


def _write_exports(
    job: dict[str, Any], username: str, results_total: dict[str, dict[str, Any]]
) -> dict[str, str]:
    """Write JSON / CSV / TXT export files for a finished job."""
    stem = _safe_stem(username, job["id"])
    rows: list[dict[str, Any]] = []
    for site, info in results_total.items():
        status = info.get("status")
        query_time = getattr(status, "query_time", None)
        rows.append(
            {
                "username": username,
                "site": site,
                "url_main": info.get("url_main") or "",
                "url_user": info.get("url_user") or "",
                "status": str(status.status) if isinstance(status, QueryResult) else str(status),
                "http_status": str(info.get("http_status", "")),
                "query_time": round(query_time, 3) if query_time is not None else None,
            }
        )

    payload = {
        "username": username,
        "generated_at": job["finished"] or _now(),
        "total": len(rows),
        "found": sum(1 for row in rows if row["status"] == _FOUND),
        "results": rows,
    }
    json_name = f"{stem}.json"
    result_file_path(json_name).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    csv_name = f"{stem}.csv"
    csv_path = result_file_path(csv_name)
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "username",
                "name",
                "url_main",
                "url_user",
                "exists",
                "http_status",
                "response_time_s",
            ]
        )
        for row in rows:
            writer.writerow(
                [
                    row["username"],
                    row["site"],
                    row["url_main"],
                    row["url_user"],
                    row["status"],
                    row["http_status"],
                    row["query_time"] if row["query_time"] is not None else "",
                ]
            )

    txt_name = f"{stem}.txt"
    lines = [row["url_user"] for row in rows if row["status"] == _FOUND and row["url_user"]]
    lines.append(f"Total Websites Username Detected On : {payload['found']}")
    result_file_path(txt_name).write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {"json": json_name, "csv": csv_name, "txt": txt_name}


def _run(job: dict[str, Any], site_data: dict[str, dict[str, Any]]) -> None:
    with _sem:
        started_ts = time.monotonic()
        with _lock:
            if job["status"] != "queued":
                return  # job was removed before it started
            job["status"] = "running"
            job["started"] = _now()
        try:
            results_total = sherlock(
                job["username"],
                copy.deepcopy(site_data),
                _Collector(job),
                proxy=PROXY,
                timeout=job["options"]["timeout"],
            )
            files = _write_exports(job, job["username"], results_total)
            with _lock:
                job["files"] = files
                job["status"] = "done"
                job["elapsed_s"] = round(time.monotonic() - started_ts, 1)
                job["finished"] = _now()
        except Exception as exc:  # noqa: BLE001 — any failure is surfaced to the client
            with _lock:
                job["status"] = "error"
                job["error"] = f"{type(exc).__name__}: {exc}"
                job["elapsed_s"] = round(time.monotonic() - started_ts, 1)
                job["finished"] = _now()


def _prune_locked() -> None:
    """Drop the oldest finished jobs when the history exceeds the limit."""
    overflow = len(_jobs) - HISTORY_LIMIT
    if overflow <= 0:
        return
    finished = sorted(
        (j for j in _jobs.values() if j["status"] in ("done", "error")),
        key=lambda j: j["created"],
    )
    for job in finished[:overflow]:
        _jobs.pop(job["id"], None)


def start_job(
    username: str, timeout: int, nsfw: bool, site_filter: list[str]
) -> dict[str, Any]:
    """Create a job and start it on a background thread."""
    site_data = load_site_data(nsfw=nsfw, site_filter=site_filter)
    if not site_data:
        raise ValueError("没有匹配到任何站点，请检查站点过滤条件")

    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {
        "id": job_id,
        "username": username,
        "status": "queued",
        "created": _now(),
        "started": None,
        "finished": None,
        "total": len(site_data),
        "completed": 0,
        "results": [],
        "error": None,
        "files": {},
        "elapsed_s": None,
        "options": {"timeout": timeout, "nsfw": nsfw, "sites": site_filter},
    }
    with _lock:
        _jobs[job_id] = job
        _prune_locked()

    threading.Thread(
        target=_run, args=(job, site_data), daemon=True, name=f"sherlock-{job_id[:8]}"
    ).start()
    return job


def serialize_job(job: dict[str, Any], include_results: bool = True) -> dict[str, Any]:
    """JSON-safe snapshot of a job (results entries are write-once)."""
    with _lock:
        snapshot = {key: value for key, value in job.items() if key != "results"}
        snapshot["found"] = sum(
            1 for r in job["results"] if r["status"] == _FOUND
        )
        if include_results:
            snapshot["results"] = list(job["results"])
    return snapshot


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock:
        return _jobs.get(job_id)


def list_jobs() -> list[dict[str, Any]]:
    with _lock:
        jobs = sorted(_jobs.values(), key=lambda j: j["created"], reverse=True)
    return [serialize_job(job, include_results=False) for job in jobs]


def delete_job(job_id: str) -> tuple[bool, str]:
    """Remove a finished job from history. Running jobs cannot be deleted."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return False, "任务不存在"
        if job["status"] in ("queued", "running"):
            return False, "任务仍在进行中，无法删除"
        _jobs.pop(job_id, None)
    return True, ""

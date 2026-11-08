"""Sherlock WebUI — FastAPI application.

Browser interface on top of the sherlock_project library. The web layer only
ever accepts a username / timeout / site-name filter; it never fetches any
client-supplied URL, so outbound requests are exclusively the username probes
that sherlock itself performs against the sites in its bundled manifest.
"""

from __future__ import annotations

import base64
import os
import re
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import runner

AUTH_USER = os.environ.get("SHERLOCK_WEB_USER") or ""
AUTH_PASSWORD = os.environ.get("SHERLOCK_WEB_PASSWORD") or ""
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASSWORD)

# Usernames are interpolated into the probe URLs built from the bundled
# manifest; this whitelist keeps the input boring on purpose.
USERNAME_RE = re.compile(r"^[\w.\-~{}?\s]{1,64}$", re.UNICODE)
_SITE_NAME_RE = re.compile(r"^.{1,64}$", re.UNICODE)

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="Sherlock WebUI",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def require_auth(request: Request) -> None:
    """Optional HTTP Basic auth, enabled via SHERLOCK_WEB_USER/PASSWORD."""
    if not AUTH_ENABLED:
        return
    header = request.headers.get("Authorization", "")
    if header.startswith("Basic "):
        try:
            user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except Exception:
            user = password = ""
        if secrets.compare_digest(
            user.encode(), AUTH_USER.encode()
        ) and secrets.compare_digest(password.encode(), AUTH_PASSWORD.encode()):
            return
    raise HTTPException(
        status_code=401,
        detail="Unauthorized",
        headers={"WWW-Authenticate": "Basic"},
    )


class SearchRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    timeout: int = Field(default=15, ge=1, le=120)
    nsfw: bool = False
    sites: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("username")
    @classmethod
    def _clean_username(cls, value: str) -> str:
        value = value.strip()
        if not USERNAME_RE.fullmatch(value):
            raise ValueError(
                "用户名仅允许字母、数字、空格及 . _ - ~ { } ? 字符，长度 1-64"
            )
        return value

    @field_validator("sites")
    @classmethod
    def _clean_sites(cls, value: list[str]) -> list[str]:
        cleaned = [name.strip() for name in value if name.strip()]
        for name in cleaned:
            if not _SITE_NAME_RE.fullmatch(name):
                raise ValueError("站点名称格式不正确")
        return cleaned


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/search", dependencies=[Depends(require_auth)])
def api_search(req: SearchRequest) -> dict:
    try:
        job = runner.start_job(req.username, req.timeout, req.nsfw, req.sites)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return runner.serialize_job(job, include_results=False)


@app.get("/api/jobs", dependencies=[Depends(require_auth)])
def api_jobs() -> list[dict]:
    return runner.list_jobs()


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def api_job_detail(job_id: str) -> dict:
    job = runner.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return runner.serialize_job(job)


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def api_job_delete(job_id: str) -> dict:
    ok, message = runner.delete_job(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail=message)
    return {"deleted": job_id}


@app.get("/api/sites", dependencies=[Depends(require_auth)])
def api_sites() -> dict:
    sites = runner.site_names()
    return {"count": len(sites), "sites": sites}


@app.get("/api/results/{filename}", dependencies=[Depends(require_auth)])
def api_result_file(filename: str) -> FileResponse:
    # Shared guard (runner.result_file_path): strict filename whitelist and
    # containment check — only plain names directly inside RESULTS_DIR pass.
    try:
        path = runner.result_file_path(filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    media = {
        ".json": "application/json",
        ".csv": "text/csv",
        ".txt": "text/plain",
    }.get(path.suffix, "application/octet-stream")
    return FileResponse(path, media_type=media, filename=filename)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

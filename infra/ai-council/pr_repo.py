#!/usr/bin/env python3
"""Репозиторий PR для ревью (SE-80, Ф1а OPS-23): откуда брать дифф и чей это прогон. Только stdlib.

До 14.11 `gh pr diff/view <N>` шли с cwd = папка кода консилиума, то есть всегда в tAIBE: номер PR HR
искался в tAIBE — «Could not resolve to a PullRequest» или молча дифф чужого PR с тем же номером.

Теперь репозиторий — явный вход: `--repo owner/name`, иначе `GH_REPO`, иначе `gh repo view` в папке
вызывающего (обёртка HR `ai-council.sh` и `review_chain.sh` папку не меняют). Дифф из `--diff-file` —
офлайн-путь: gh не зовётся, репозиторий — только из `--repo`/`GH_REPO`.

Продукт — по `github.repo` в `instances/*.json`: run_id прогона `<slug>:pr-<N>`, без совпадения —
`unknown:pr-<N>`. run_id — ключ счётчика вызовов и строк `cloud_calls` (cloud.py).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

INSTANCES = Path(__file__).resolve().parents[2] / "instances"
# gh принимает [HOST/]OWNER/REPO (`-R`, GH_REPO).
REPO_RE = re.compile(r"^(?:[A-Za-z0-9.-]+/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
NO_REPO = "репозиторий PR не определён: --repo owner/name, GH_REPO или запуск из папки репозитория PR"


def resolve_repo(explicit: str = "", *, probe: bool = True, cwd: str | None = None, run=subprocess.run,
                 env=None) -> str:
    """--repo → GH_REPO → `gh repo view` в папке вызывающего (только при probe). Не нашли — ""."""
    env = os.environ if env is None else env
    for value in (explicit, env.get("GH_REPO", "")):
        if value.strip():
            if not REPO_RE.match(value.strip()):
                raise ValueError(f"репозиторий PR «{value.strip()}» — не [HOST/]OWNER/REPO")
            return value.strip()
    if not probe:
        return ""
    try:
        res = run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                  cwd=cwd or os.getcwd(), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    name = (res.stdout or "").strip() if res.returncode == 0 else ""
    return name if REPO_RE.match(name) else ""


def product_slug(repo: str, instances: Path = INSTANCES) -> str:
    """Slug продукта по `github.repo` (без учёта регистра и HOST/). Нет совпадения — "unknown"."""
    want = "/".join(repo.strip().lower().split("/")[-2:])
    if want.count("/") != 1:
        return "unknown"
    for path in sorted(instances.glob("*.json")):
        if path.name.startswith("_"):
            continue
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        github = data.get("github") if isinstance(data, dict) else None
        if isinstance(github, dict) and str(github.get("repo", "")).strip().lower() == want:
            return str(data.get("slug") or path.stem)
    return "unknown"


def run_id(repo: str, pr: str, instances: Path = INSTANCES) -> str:
    return f"{product_slug(repo, instances) if repo else 'unknown'}:pr-{pr}"


def pr_inputs(pr: str, repo: str, *, diff_file: str = "", body_file: str = "", run=subprocess.run,
              env=None) -> tuple[str, str]:
    """Дифф и описание PR: из файлов или `gh pr diff/view <N> -R <repo>`. Без репозитория gh не зовётся."""
    env = os.environ if env is None else env
    if diff_file:
        diff = Path(diff_file).read_text()
        body = Path(body_file).read_text() if body_file else env.get("PR_BODY", "")
        return diff, body
    if not repo:
        raise ValueError(NO_REPO)
    gh = dict(capture_output=True, text=True, check=True)
    diff = run(["gh", "pr", "diff", pr, "-R", repo], **gh).stdout
    body = (Path(body_file).read_text() if body_file
            else run(["gh", "pr", "view", pr, "-R", repo, "--json", "body", "--jq", ".body"], **gh).stdout)
    return diff, body

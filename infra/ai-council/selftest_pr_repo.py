#!/usr/bin/env python3
"""AI Council — самопроверка репозитория PR и run_id ревью (`pr_repo.py`, SE-80, Ф1а OPS-23). Только stdlib, сети нет.

Вызывается из selftest_pr_review.py: порядок --repo → GH_REPO → `gh repo view` в папке вызывающего, `-R` у
`gh pr diff/view`, отказ без репозитория (код 1), slug продукта по `instances/*.json`, run_id `<slug>:pr-<N>`.
Сквозные проверки `main` — с поддельным `gh` в PATH, запуск «из папки HR».
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pr_repo                       # noqa: E402

HR = "agolubenk/HR_Helper-v2"
FAKE_GH = """#!/bin/sh
printf '%s|%s\\n' "$(pwd -P)" "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "repo view") if [ -n "$FAKE_GH_REPO" ]; then echo "$FAKE_GH_REPO"; exit 0; fi
               echo "none of the git remotes point to a known GitHub host" >&2; exit 1 ;;
  "pr diff") cat "$FAKE_GH_DIFF" ;;
  "pr view") echo "тело PR" ;;
esac
"""
DIFF = ("diff --git a/x.py b/x.py\nindex 1111111..2222222 100644\n--- a/x.py\n+++ b/x.py\n"
        "@@ -1,1 +1,2 @@\n a\n+b\n")


class _Run:
    """Подмена subprocess.run: запоминает argv и kwargs, отвечает заданным stdout/кодом или бросает."""

    def __init__(self, out: str = "", code: int = 0, exc: Exception | None = None):
        self.out, self.code, self.exc, self.calls = out, code, exc, []

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if self.exc:
            raise self.exc
        return SimpleNamespace(stdout=self.out, returncode=self.code)


def _raises(fn) -> str:
    try:
        fn()
    except ValueError as exc:
        return str(exc)
    return ""


def _resolve(check) -> None:
    run = _Run("c/d\n")
    check("репозиторий PR: --repo важнее GH_REPO, gh не зовётся",
          pr_repo.resolve_repo("a/b", env={"GH_REPO": "c/d"}, run=run) == "a/b" and not run.calls)
    check("репозиторий PR: GH_REPO без --repo", pr_repo.resolve_repo("", env={"GH_REPO": " c/d "}, run=run) == "c/d"
          and not run.calls)
    check("репозиторий PR: HOST/OWNER/REPO принят", pr_repo.resolve_repo("github.com/a/b", env={}) == "github.com/a/b")
    bad = [_raises(lambda v=v: pr_repo.resolve_repo(v, env={})) for v in ("a b", "a", "a/b/c/d", "a/b;rm")]
    check("репозиторий PR: кривое имя — ошибка запуска, не тихий прогон", all(bad), str(bad))
    check("репозиторий PR: --diff-file (probe выключен) — gh не зовётся",
          pr_repo.resolve_repo("", probe=False, env={}, run=run) == "" and not run.calls)
    run = _Run(HR + "\n")
    got = pr_repo.resolve_repo("", env={}, run=run)
    check("репозиторий PR: иначе — gh repo view в папке вызывающего, не в папке кода консилиума",
          got == HR and run.calls and run.calls[0][1].get("cwd") == os.getcwd()
          and run.calls[0][0][:3] == ["gh", "repo", "view"], str(run.calls))
    empty = [pr_repo.resolve_repo("", env={}, run=r) for r in
             (_Run("", 1), _Run("not a repo"), _Run(exc=FileNotFoundError("gh")),
              _Run(exc=subprocess.TimeoutExpired("gh", 30)))]
    check("репозиторий PR: gh не нашёл / нет gh / мусор / таймаут — пусто", empty == [""] * 4, str(empty))


def _slugs(check, tmp: Path) -> None:
    inst = tmp / "instances"
    inst.mkdir(exist_ok=True)
    (inst / "taibe.json").write_text(json.dumps({"slug": "taibe", "github": {"repo": "agolubenk/tAIBE"}}))
    (inst / "hr-helper.json").write_text(json.dumps({"slug": "hr-helper", "github": {"repo": HR}}))
    (inst / "noslug.json").write_text(json.dumps({"github": {"repo": "o/noslug"}}))
    (inst / "_shared.json").write_text(json.dumps({"slug": "shared", "github": {"repo": "o/shared"}}))
    (inst / "broken.json").write_text("{")
    got = {r: pr_repo.product_slug(r, inst) for r in
           (HR, "AGOLUBENK/hr_helper-v2", "github.com/agolubenk/tAIBE", "o/noslug", "o/shared", "x/y", "", "x")}
    check("репозиторий PR: slug по github.repo — регистр и HOST/ не мешают, _*.json и битый файл пропущены",
          got == {HR: "hr-helper", "AGOLUBENK/hr_helper-v2": "hr-helper", "github.com/agolubenk/tAIBE": "taibe",
                  "o/noslug": "noslug", "o/shared": "unknown", "x/y": "unknown", "": "unknown", "x": "unknown"},
          str(got))
    check("репозиторий PR: run_id — <slug>:pr-<N>, без репозитория или без совпадения — unknown",
          [pr_repo.run_id(HR, "600", inst), pr_repo.run_id("", "600", inst), pr_repo.run_id("x/y", "7", inst)]
          == ["hr-helper:pr-600", "unknown:pr-600", "unknown:pr-7"])
    check("репозиторий PR: настоящие instances/ — HR → hr-helper, tAIBE → taibe",
          [pr_repo.run_id(HR, "600"), pr_repo.run_id("agolubenk/tAIBE", "236")] == ["hr-helper:pr-600", "taibe:pr-236"])


def _inputs(check, tmp: Path) -> None:
    run = _Run("дифф")
    diff, body = pr_repo.pr_inputs("600", HR, run=run)
    argv = [c[0] for c in run.calls]
    check("репозиторий PR: gh pr diff/view получают -R <репозиторий>, папка не задаётся",
          argv == [["gh", "pr", "diff", "600", "-R", HR],
                   ["gh", "pr", "view", "600", "-R", HR, "--json", "body", "--jq", ".body"]]
          and all("cwd" not in c[1] for c in run.calls) and diff == "дифф", str(argv))
    run = _Run("дифф")
    why = _raises(lambda: pr_repo.pr_inputs("600", "", run=run))
    check("репозиторий PR: без репозитория и без --diff-file — отказ с подсказкой, gh не зовётся",
          why == pr_repo.NO_REPO and not run.calls, why)
    path = tmp / "pr.diff"
    path.write_text(DIFF)
    got = pr_repo.pr_inputs("1", "", diff_file=str(path), run=run, env={"PR_BODY": "тело"})
    check("репозиторий PR: --diff-file — без gh, тело из PR_BODY", got == (DIFF, "тело") and not run.calls)


def _run_id_in_review(check, gr) -> None:
    seen: list = []

    class _Client:
        def chat(self, scope, purpose, model, messages, temperature=0.2, max_tokens=6000):
            seen.append(scope)
            return SimpleNamespace(ok=True, text='{"verdict": "accept", "findings": [], "checked": []}',
                                   error="", model=model)

    calls, _skipped, _whole = gr.plan_calls({"a": "f"}, DIFF, 3000)
    common = dict(pr="600", model="m", prompt_of=lambda c: "p", max_tokens=10, deadline_s=60.0, log=lambda m: None)
    report, _code = gr.run_review(_Client(), calls, run_id="hr-helper:pr-600", **common)
    old, _code = gr.run_review(_Client(), calls, **common)
    check("репозиторий PR: run_id идёт ключом вызова и в _meta; без него — прежний pr-<N>",
          seen == ["hr-helper:pr-600", "pr-600"] and report["_meta"]["run_id"] == "hr-helper:pr-600"
          and old["_meta"]["run_id"] == "pr-600", str(seen))


@contextlib.contextmanager
def _caller(tmp: Path, repo: str):
    """Процесс «из папки HR»: поддельный gh первым в PATH, без GH_REPO."""
    bin_dir, hr_dir, log = tmp / "bin", tmp / "hr-checkout", tmp / "gh.log"
    bin_dir.mkdir(exist_ok=True)
    hr_dir.mkdir(exist_ok=True)
    (bin_dir / "gh").write_text(FAKE_GH)
    (bin_dir / "gh").chmod(0o755)
    (tmp / "gh.diff").write_text(DIFF)
    log.write_text("")
    keys = ("PATH", "GH_REPO", "FAKE_GH_LOG", "FAKE_GH_REPO", "FAKE_GH_DIFF")
    saved, cwd = {k: os.environ.get(k) for k in keys}, os.getcwd()
    os.environ.pop("GH_REPO", None)
    os.environ.update(PATH=f"{bin_dir}{os.pathsep}{saved['PATH'] or ''}", FAKE_GH_LOG=str(log),
                      FAKE_GH_REPO=repo, FAKE_GH_DIFF=str(tmp / "gh.diff"))
    os.chdir(hr_dir)
    try:
        yield SimpleNamespace(log=log, folder=str(hr_dir.resolve()))
    finally:
        os.chdir(cwd)
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _main(check, gr, tmp: Path) -> None:
    out = str(tmp / "pr-repo-out.json")
    with _caller(tmp, HR) as env, contextlib.redirect_stdout(io.StringIO()):
        code = gr.main(["600", out, "--dry-run"])
        lines = env.log.read_text().splitlines()
    check("репозиторий PR: прогон из папки HR — gh repo view там, дифф из HR по -R",
          code == gr.EXIT_OK and lines[:1] == [f"{env.folder}|repo view --json nameWithOwner -q .nameWithOwner"]
          and f"{env.folder}|pr diff 600 -R {HR}" in lines, str(lines))
    err = io.StringIO()
    with _caller(tmp, "") as env, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        code = gr.main(["600", out, "--dry-run"])
        lines = env.log.read_text().splitlines()
    check("репозиторий PR: репозиторий не определён — код 1 с подсказкой, дифф не запрашивается",
          code == gr.EXIT_START and pr_repo.NO_REPO in err.getvalue() and not any("pr diff" in x for x in lines),
          err.getvalue()[:200])

    captured: dict = {}
    real = gr.run_review

    def fake_review(client, calls, **kw):
        captured.update(kw)
        return {"_meta": {"stopped": "", "not_passed": []}}, gr.EXIT_OK

    gr.run_review = fake_review
    try:
        with _caller(tmp, HR), contextlib.redirect_stdout(io.StringIO()):
            code = gr.main(["600", out, "--backend", "opencode"])
        meta = json.loads(Path(out).read_text())["_meta"]
        check("репозиторий PR: main передаёт run_id hr-helper:pr-600 и пишет repo в отчёт",
              code == gr.EXIT_OK and captured.get("run_id") == "hr-helper:pr-600" and meta.get("repo") == HR,
              f"{captured.get('run_id')} {meta.get('repo')}")
        path = tmp / "offline.diff"
        path.write_text(DIFF)
        with _caller(tmp, HR) as env, contextlib.redirect_stdout(io.StringIO()):
            code = gr.main(["7", out, "--backend", "opencode", "--diff-file", str(path)])
            lines = env.log.read_text().splitlines()
        check("репозиторий PR: --diff-file без --repo — gh не зовётся, run_id unknown:pr-7",
              code == gr.EXIT_OK and not lines and captured.get("run_id") == "unknown:pr-7", str(lines))
    finally:
        gr.run_review = real


def run(tmp: Path, check) -> None:
    import glm_pr_review as gr
    _resolve(check)
    _slugs(check, tmp)
    _inputs(check, tmp)
    _run_id_in_review(check, gr)
    _main(check, gr, tmp)


if __name__ == "__main__":
    import tempfile
    failed: list = []

    def _check(name: str, ok: bool, detail: str = "") -> None:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok or not detail else f" — {detail}"))
        if not ok:
            failed.append(name)

    with tempfile.TemporaryDirectory() as d:
        run(Path(d), _check)
    sys.exit(1 if failed else 0)

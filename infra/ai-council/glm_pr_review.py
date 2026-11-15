#!/usr/bin/env python3
"""Ревью PR на GLM: независимые линзы через CloudClient консилиума (квота и бюджет общие с воркером).

    python3 infra/ai-council/glm_pr_review.py <PR> <out.json> [модель] [линзы.json] [max_tokens] [флаги]
    python3 infra/ai-council/glm_pr_review.py 161 /tmp/r.json --dry-run      # план вызовов без сети

Запускать из основного checkout: отметка квоты подписки и счётчики бюджета живут в его
`.claude/council/council.db`. В worktree базы нет — скрипт откажется, а не потратит квоту вслепую.

Зачем такой (14–15.10.2026, docs/specs/ai-council.md §17.7): линза «корректность» на диффах от ~500 строк
падала 502 proxy_error — Z.AI рвёт генерацию через ~300 с, а `_post` повторял её четырежды: до 20 мин на
линзу, и агент запускал её снова. Теперь:

* вызов — не больше `--attempts` попыток по `--attempt-timeout` с (330: дольше обрыва Z.AI, чтобы пришёл
  его 502, а не локальный таймаут — тот ставит маркер сбоя провайдера на 5 мин);
* линза с `"split": true` (по умолчанию — корректность) идёт частями по файлам: ядро отдельно от тестов и UI,
  часть не больше `--chunk-chars` символов; сгенерированное (lock-файлы, снапшоты) не отправляется ни одной линзе;
* квота подписки, лимит бюджета, ошибка конфигурации или недоступная сеть — ревью останавливается сразу;
* `--breaker` ответа 5xx подряд в одной линзе — оставшиеся части этой линзы не идут, остальные линзы идут
  (502 на длинной генерации — беда линзы, а не GLM целиком);
* общий потолок `--deadline-min`: новый вызов после него не начинается. Что не прошло — в `_meta.not_passed`
  и в коде выхода: эти линзы подхватывает другой рецензент.

Линзы — JSON {"имя": "фокус"} или {"имя": {"focus": "…", "split": true}}. Дифф и описание — `gh pr diff/view -R`
или `--diff-file`/`--body-file` (env PR_DIFF_FILE/PR_BODY — как у прежней версии из handoff). Репозиторий PR и
run_id `<продукт>:pr-<N>` — `pr_repo.py` (`--repo`, GH_REPO или папка вызывающего; SE-80, Ф1а).
Выход: 0 — все линзы прошли (вердикт может быть fail); 2 — часть не прошла; 3 — квота/бюджет; 1 — запуск.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pr_repo                      # noqa: E402

DEFAULT_LENSES: dict = {
    "корректность и отказы": {
        "focus": "логика по строкам диффа: условия и границы, гонки и повторный вход, ошибки и таймауты, откат и "
                 "идемпотентность, что видит пользователь при сбое; проверяют ли тесты изменённое поведение",
        "split": True,
    },
    "ресурсы": "стоимость на всех уровнях: сервер (CPU, память, запросы к БД, N+1, очереди), сеть и браузер на 3G и "
               "слабом Android, квоты и платные вызовы, машина разработчика. Отличай измеренное от гипотезы",
    "продукт и простота": "что меняется для пользователя, обратная совместимость, понятность ошибок и пустых "
                          "состояний, i18n; лишняя сложность и дублирование — можно ли проще",
    "безопасность и контракт": "доступ между компаниями и ролями, ввод извне (тела запросов, файлы, вебхуки), "
                               "секреты и персональные данные в логах и ответах, контракт API и типы",
}
SYSTEM = (
    "Ты — независимый рецензент PR с одной линзой. Ищи дефекты ТОЛЬКО по строкам диффа; каждая находка — с файлом и "
    "строкой из диффа и конкретным сценарием отказа. Не придумывай файлы и код, которого нет в диффе. Если тебе дана "
    "часть диффа, отсутствие кода из других частей дефектом не считай. Если по линзе дефектов нет — перечисли "
    "проверенные оси. Будь краток: не больше 6 находок, без пересказа диффа. Ответ строго JSON: "
    '{"verdict":"accept|fail","findings":[{"severity":"critical|major|minor","where":"файл:строка",'
    '"scenario":"...","fix":"..."}],"checked":["..."]}'
)
BODY_CHARS = 5000
EXIT_OK, EXIT_START, EXIT_NOT_PASSED, EXIT_LIMIT = 0, 1, 2, 3

# ── дифф → части ─────────────────────────────────────────────────────────────
FILE_HEADER_RE = re.compile(r'^diff --git "?a/(.*?)"? "?b/(.*?)"?$', re.M)
HUNK_RE = re.compile(r"^@@ ", re.M)
GENERATED_RE = re.compile(r"(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|"
                          r"Cargo\.lock)$|\.snap$|\.min\.(js|css)$|(^|/)dist/|(^|/)ruDefaultValuesFlat\.json$")
TESTS_RE = re.compile(r"(^|/)(__tests__|__mocks__|tests?|e2e)/|\.(spec|test)\.[cm]?[jt]sx?$|"
                      r"(^|/)(selftest[^/]*|test_[^/]+|[^/]+_test)\.py$")
UI_RE = re.compile(r"^apps/(frontend|landings|extension)/|\.(tsx|jsx|css|scss|less|html|vue|svg)$|(^|/)ui/")
GROUPS = ("core", "tests", "ui")     # документация — в «ядре»: она описывает поведение ядра


def file_group(path: str) -> str:
    if GENERATED_RE.search(path):
        return "generated"
    if TESTS_RE.search(path):
        return "tests"
    if UI_RE.search(path) and not path.endswith(".md"):
        return "ui"
    return "core"


def split_diff(diff: str) -> list[tuple[str, str]]:
    """Дифф `git diff`/`gh pr diff` → [(путь, кусок с заголовком)] в исходном порядке."""
    heads = list(FILE_HEADER_RE.finditer(diff))
    if not heads:
        return [("(дифф)", diff)] if diff.strip() else []
    return [(m.group(2), diff[m.start():(heads[i + 1].start() if i + 1 < len(heads) else len(diff))])
            for i, m in enumerate(heads)]


def _cut_lines(text: str, step: int) -> list[str]:
    out, cur = [], ""
    for line in text.splitlines(keepends=True):
        if cur and len(cur) + len(line) > step:
            out.append(cur)
            cur = ""
        cur += line
    return out + ([cur] if cur else [])


def _pieces(section: str, limit: int) -> list[str]:
    """Кусок файла больше лимита — по ханкам (заголовок файла повторяется), гигантский ханк — по строкам."""
    hunks = [m.start() for m in HUNK_RE.finditer(section)]
    if len(section) <= limit or not hunks:
        return [section] if len(section) <= limit else _cut_lines(section, limit)
    head, out = section[:hunks[0]], []
    cur, step = head, max(limit - len(head), 1000)
    bounds = hunks + [len(section)]
    for a, b in zip(bounds, bounds[1:]):
        hunk = section[a:b]
        if len(head) + len(hunk) > limit:
            if cur != head:
                out.append(cur)
                cur = head
            out.extend(head + piece for piece in _cut_lines(hunk, step))
            continue
        if len(cur) + len(hunk) > limit:
            out.append(cur)
            cur = head
        cur += hunk
    return out + ([cur] if cur != head else [])


@dataclass
class Part:
    group: str
    files: list = field(default_factory=list)
    text: str = ""
    label: str = ""


def plan_parts(diff: str, limit: int) -> tuple[list[Part], list[str]]:
    """Части для линзы с делением: группы по порядку GROUPS, внутри — файлы подряд до `limit` символов.
    Возвращает (части, пропущенные сгенерированные файлы)."""
    by_group: dict = {g: [] for g in GROUPS}
    skipped = []
    for path, section in split_diff(diff):
        group = file_group(path)
        if group == "generated":
            skipped.append(path)
        else:
            by_group[group].append((path, section))
    parts: list[Part] = []
    for group in GROUPS:
        cur = Part(group)
        for path, section in by_group[group]:
            for piece in _pieces(section, limit):
                if cur.text and len(cur.text) + len(piece) > limit:
                    parts.append(cur)
                    cur = Part(group)
                cur.text += piece
                if path not in cur.files:
                    cur.files.append(path)
        if cur.text:
            parts.append(cur)
    total = {g: sum(1 for p in parts if p.group == g) for g in GROUPS}
    seen: dict = {}
    for p in parts:
        seen[p.group] = seen.get(p.group, 0) + 1
        p.label = f"{p.group} {seen[p.group]}/{total[p.group]}"
    return parts, skipped


@dataclass
class Call:
    lens: str
    focus: str
    part: Part | None = None        # None — весь дифф без сгенерированного


def normalize_lenses(raw: dict) -> dict:
    out = {}
    for name, spec in raw.items():
        if isinstance(spec, str):
            out[name] = {"focus": spec, "split": False}
        elif isinstance(spec, dict) and isinstance(spec.get("focus", ""), str):
            out[name] = {"focus": spec.get("focus", ""), "split": bool(spec.get("split"))}
        else:
            raise ValueError(f"линза «{name}»: ожидается строка или {{\"focus\": …, \"split\": …}}")
    if not out:
        raise ValueError("ни одной линзы")
    return out


def plan_calls(lenses: dict, diff: str, chunk_chars: int) -> tuple[list[Call], list[str], str]:
    """(вызовы, пропущенные сгенерированные файлы, дифф без них — для линз без деления)."""
    parts, skipped = plan_parts(diff, chunk_chars)
    whole = "".join(section for path, section in split_diff(diff) if file_group(path) != "generated")
    calls: list[Call] = []
    for name, spec in normalize_lenses(lenses).items():
        if spec["split"] and len(parts) > 1:
            calls.extend(Call(name, spec["focus"], p) for p in parts)
        else:
            calls.append(Call(name, spec["focus"]))
    return calls, skipped, whole


def build_prompt(call: Call, body: str, whole: str, skipped: list, all_files: list) -> str:
    head = f"Линза: {call.lens}. Фокус: {call.focus}."
    if call.part is not None:
        others = [f for f in all_files if f not in call.part.files and f not in skipped]
        head += (f"\n\nЧасть {call.part.label} диффа, файлы: {', '.join(call.part.files)}. Остальные файлы PR — в других "
                 f"частях" + (f" ({', '.join(others[:40])}{' …' if len(others) > 40 else ''})" if others else "") + ".")
    if skipped:
        head += f"\nНе показаны (сгенерированные): {', '.join(skipped[:20])}."
    diff = call.part.text if call.part is not None else whole
    return f"{head}\n\nОписание PR:\n{body[:BODY_CHARS]}\n\nДифф:\n{diff}"


# ── исполнение ───────────────────────────────────────────────────────────────
STOPPING = ("quota", "budget", "config", "network")


def classify_failure(error: str) -> str:
    """quota | budget | config | network — ревью останавливается; provider — 5xx/перегрузка (считается подряд
    в линзе); other — не прошла только эта часть."""
    import cloud
    err = error or ""
    if cloud.QUOTA_ERROR_MARK in err or err.startswith("квота подписки"):
        return "quota"
    if re.match(r"(исчерпан|лимит частоты|вызов оценочно стоит)", err):
        return "budget"
    if (re.match(r"(облако выключено|нет ключа|модель \S+ не объявлена)", err) or "pay-as-you-go" in err):
        return "config"
    if re.match(r"сеть/", err) or "кэш-маркер сбоя" in err:
        return "network"
    if re.search(r"HTTP (5\d\d|429)|proxy_error", err):
        return "provider"
    return "other"


def parse_answer(res) -> dict:
    import cloud
    if isinstance(getattr(res, "data", None), dict):
        return res.data
    parsed = cloud._parse_json_loose(res.text or "")
    return parsed if isinstance(parsed, dict) else {"raw": (res.text or "")[:3000]}


# Синонимы вердикта: файлы линз пишут «accept|changes» (как ревью команды), SYSTEM просит accept|fail. 12.11 линза
# корректности ответила валидным JSON с verdict «changes» — и трижды ушла в брак с пустым raw (OPS-47).
VERDICT_SYNONYMS = {"changes": "fail", "request_changes": "fail", "changes_requested": "fail", "reject": "fail",
                    "rejected": "fail", "approve": "accept", "approved": "accept", "pass": "accept"}


def norm_verdict(value) -> str:
    v = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return VERDICT_SYNONYMS.get(v, v)


def no_verdict(parsed: dict) -> str:
    """Почему ответ — не вердикт: не JSON, JSON без verdict или verdict не accept/fail (OPS-47)."""
    if "raw" in parsed and len(parsed) == 1:
        return "ответ не JSON — см. raw"
    if "verdict" not in parsed:
        return f"в JSON нет verdict (ключи: {', '.join(sorted(map(str, parsed)))[:150]}) — см. raw"
    return f"verdict «{str(parsed.get('verdict'))[:40]}» — не accept/fail — см. raw"


def _lens_record() -> dict:
    return {"status": "skipped", "verdict": None, "ok": False, "seconds": 0, "error": "",
            "findings": [], "checked": [], "parts": []}


def _finish_lens(rec: dict) -> None:
    parts = rec["parts"]
    passed = [p for p in parts if p["ok"]]
    rec["status"] = ("ok" if parts and len(passed) == len(parts) else "skipped" if not any(p["attempted"] for p in parts)
                     else "failed" if not passed else "partial")
    rec["ok"] = rec["status"] == "ok"
    verdicts = [p["verdict"] for p in passed]
    rec["verdict"] = "fail" if "fail" in verdicts else ("accept" if rec["ok"] else None)
    rec["seconds"] = sum(p["seconds"] for p in parts)
    rec["error"] = "; ".join(f"{p['part']}: {p['error']}" for p in parts if p["error"])[:1000]


def resume_mismatch(prior: dict | None, pr: str, diff_sha: str) -> str:
    """Почему прошлый отчёт нельзя продолжить: другой PR или другой дифф (новые коммиты). Пусто — можно."""
    if not prior:
        return ""
    meta = prior.get("_meta") or {}
    if str(meta.get("pr")) != str(pr):
        return f"отчёт PR {meta.get('pr')}, а ревьюится {pr}"
    if meta.get("diff_sha") != diff_sha:
        return "дифф изменился после прошлого прогона (или отчёт без diff_sha)"
    return ""


def _carry_part(rec: dict, prior: dict | None, lens: str, label: str) -> bool:
    """--resume: часть, прошедшая в прошлом отчёте (другой рецензент цепочки), переносится как есть, без вызова."""
    prev = (prior or {}).get(lens) or {}
    done = next((p for p in prev.get("parts") or [] if p.get("part") == label and p.get("ok")), None)
    if not done:
        return False
    rec["parts"].append({**done, "reviewer": done.get("reviewer") or (prior or {}).get("_meta", {}).get("backend", "glm")})
    rec["findings"].extend(f for f in prev.get("findings") or [] if f.get("part", label) == label)
    rec["checked"].extend(c for c in prev.get("checked") or [] if c not in rec["checked"])
    return True


def run_review(client, calls: list, *, pr: str, model: str, prompt_of, max_tokens: int, deadline_s: float,
               breaker: int = 2, clock=time.monotonic, on_progress=None, log=print, prior: dict | None = None,
               backend: str = "glm", diff_sha: str = "", run_id: str = "") -> tuple[dict, int]:
    """Вызовы по одному. Возвращает (отчёт, код выхода). prior — отчёт прошлого рецензента цепочки (--resume)."""
    run_id = run_id or f"pr-{pr}"
    out: dict = {"_meta": {"pr": pr, "run_id": run_id, "model": model, "backend": backend, "calls": len(calls),
                           "stopped": "", "not_passed": [], "diff_sha": diff_sha}}
    started, stop, stop_kind = clock(), "", ""
    in_row: dict = {}         # линза → ответов 5xx подряд
    dropped: dict = {}        # линза → почему её оставшиеся части не идут
    for call in calls:
        rec = out.setdefault(call.lens, _lens_record())
        label = call.part.label if call.part else "весь дифф"
        if _carry_part(rec, prior, call.lens, label):
            continue
        part = {"part": label, "files": call.part.files if call.part else [], "attempted": False, "ok": False,
                "seconds": 0, "verdict": None, "error": "", "kind": "", "reviewer": backend}
        rec["parts"].append(part)
        if not stop and clock() - started > deadline_s:
            stop, stop_kind = f"потолок {round(deadline_s / 60)} мин на всё ревью", "deadline"
        why_not = stop or dropped.get(call.lens, "")
        if why_not:
            part["error"] = f"не запускалась: {why_not}"
            continue
        t0 = clock()
        part["attempted"] = True
        res = client.chat(run_id, f"pr_review.{call.lens}", model,
                          [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt_of(call)}],
                          temperature=0.2, max_tokens=max_tokens)
        part["seconds"] = round(clock() - t0)
        parsed = parse_answer(res) if res.ok else {}
        verdict = norm_verdict(parsed.get("verdict"))
        if res.ok and verdict in ("accept", "fail"):
            in_row[call.lens] = 0
            part.update(ok=True, verdict=verdict)
            for f in parsed.get("findings") or []:
                if isinstance(f, dict):
                    rec["findings"].append({**f, "part": label} if call.part else f)
            rec["checked"].extend(c for c in (parsed.get("checked") or []) if c not in rec["checked"])
        else:
            kind = "other" if res.ok else classify_failure(res.error)
            part.update(kind=kind, error=(res.error or no_verdict(parsed))[:300])
            if res.ok:
                # Исходный текст, а не parsed["raw"]: у JSON без verdict поля raw нет — ответ терялся (OPS-47).
                part["raw"] = (res.text or "")[:3000]
            in_row[call.lens] = in_row.get(call.lens, 0) + 1 if kind == "provider" else 0
            if kind in STOPPING:
                stop, stop_kind = f"{kind}: {res.error[:200]}", kind
            elif kind == "provider" and in_row[call.lens] >= breaker:
                dropped[call.lens] = f"{in_row[call.lens]} ответа 5xx подряд в линзе ({res.error[:120]})"
        _log_part(log, call.lens, part, rec)
        if on_progress:
            on_progress(out)
    reviewers: dict = {}
    for name, rec in out.items():
        if name != "_meta":
            _finish_lens(rec)
            out["_meta"]["not_passed"] += [f"{name} ({p['part']})" for p in rec["parts"] if not p["ok"]]
            reviewers[name] = sorted({p.get("reviewer", backend) for p in rec["parts"] if p["ok"]})
    out["_meta"]["reviewers"] = reviewers
    out["_meta"]["stopped"] = stop
    out["_meta"]["dropped_lenses"] = dropped
    code = (EXIT_LIMIT if stop_kind in ("quota", "budget") else EXIT_START if stop_kind == "config"
            else EXIT_NOT_PASSED if out["_meta"]["not_passed"] else EXIT_OK)
    return out, code


def _log_part(log, lens: str, part: dict, rec: dict) -> None:
    log(f"== {lens} [{part['part']}] ({part['seconds']} s, ok={part['ok']}): {part['verdict'] or '—'} {part['error']}")
    if part["ok"]:
        for f in rec["findings"]:
            if f.get("part", part["part"]) == part["part"]:
                log(f"  [{f.get('severity')}] {f.get('where')} — {str(f.get('scenario'))[:300]} → {str(f.get('fix'))[:200]}")


# ── запуск ───────────────────────────────────────────────────────────────────
def _parse_args(argv):
    ap = argparse.ArgumentParser(description="Ревью PR на GLM по линзам (см. шапку модуля).")
    ap.add_argument("pr")
    ap.add_argument("out", type=Path)
    ap.add_argument("model", nargs="?", default="",
                    help="glm: glm-5; opencode: $OPENCODE_REVIEW_MODEL или opencode-go/glm-5.3")
    ap.add_argument("lenses", nargs="?", default="", help="JSON-файл линз; пусто — линзы по умолчанию")
    ap.add_argument("max_tokens", nargs="?", type=int, default=6000)
    ap.add_argument("--attempts", type=int, default=2, help="попыток на вызов (5xx, перегрузка)")
    ap.add_argument("--attempt-timeout", type=int, default=330, help="секунд на попытку")
    ap.add_argument("--chunk-chars", type=int, default=24000, help="размер части для линз с делением")
    ap.add_argument("--deadline-min", type=float, default=45.0, help="потолок на всё ревью")
    ap.add_argument("--breaker", type=int, default=2, help="ответов 5xx подряд в линзе — её остаток не идёт")
    ap.add_argument("--diff-file", default=os.environ.get("PR_DIFF_FILE", ""))
    ap.add_argument("--body-file", default="")
    ap.add_argument("--repo", default="", help="репозиторий PR owner/name; иначе GH_REPO или папка вызывающего")
    ap.add_argument("--dry-run", action="store_true", help="только план вызовов, без сети и базы")
    ap.add_argument("--backend", choices=("glm", "opencode"), default="glm",
                    help="кто рецензирует; цепочка opencode → glm → Claude — review_chain.sh")
    ap.add_argument("--resume", default="", help="отчёт прошлого рецензента: прошедшие части не повторяются")
    args = ap.parse_args(argv)
    args.model = args.model or ("glm-5" if args.backend == "glm"
                                else os.environ.get("OPENCODE_REVIEW_MODEL", "opencode-go/glm-5.3"))
    return args


def main(argv=None) -> int:
    args = _parse_args(argv)
    try:
        lenses = json.loads(Path(args.lenses).read_text()) if args.lenses else DEFAULT_LENSES
        repo = pr_repo.resolve_repo(args.repo, probe=not args.diff_file)
        diff, body = pr_repo.pr_inputs(args.pr, repo, diff_file=args.diff_file, body_file=args.body_file)
        calls, skipped, whole = plan_calls(lenses, diff, max(args.chunk_chars, 2000))
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"запуск: {exc}", file=sys.stderr)
        return EXIT_START
    all_files, run_id = [path for path, _ in split_diff(diff)], pr_repo.run_id(repo, args.pr)
    per_lens: dict = {}
    for c in calls:
        per_lens.setdefault(c.lens, []).append(c.part.label if c.part else "весь дифф")
    # Репозиторий видно до первого вызова: PR HR из папки tAIBE без --repo — это PR tAIBE с тем же номером.
    print(f"PR {args.pr}: репозиторий {repo or '— (дифф из файла)'}, run_id {run_id}", flush=True)
    print(f"план: {len(per_lens)} линз, {len(calls)} вызовов; дифф {len(diff)} симв., файлов {len(all_files)}"
          + (f"; не отправлены (сгенерированные): {', '.join(skipped)}" if skipped else ""), flush=True)
    for name, labels in per_lens.items():
        print(f"  {name}: {', '.join(labels)}", flush=True)
    if not whole.strip():
        print("нечего ревьюить: в диффе только сгенерированные файлы", flush=True)
        return EXIT_OK
    if args.dry_run:
        return EXIT_OK
    try:
        prior = json.loads(Path(args.resume).read_text()) if args.resume and Path(args.resume).exists() else None
    except (OSError, ValueError) as exc:
        print(f"запуск: --resume {args.resume}: {exc}", file=sys.stderr)
        return EXIT_START
    diff_sha = hashlib.sha256(diff.encode()).hexdigest()[:16]
    stale = resume_mismatch(prior, args.pr, diff_sha)
    if stale:
        print(f"--resume не применён: {stale} — все части ревьюятся заново", flush=True)
        prior = None
    body = body or ""

    def save(report: dict) -> None:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=1))

    def review(client) -> tuple[dict, int]:
        return run_review(
            client, calls, pr=args.pr, model=args.model, max_tokens=args.max_tokens,
            prompt_of=lambda c: build_prompt(c, body, whole, skipped, all_files),
            deadline_s=args.deadline_min * 60, breaker=max(args.breaker, 1),
            on_progress=save, log=lambda m: print(m, flush=True), prior=prior, backend=args.backend,
            diff_sha=diff_sha, run_id=run_id)

    if args.backend == "opencode":
        from opencode_client import OpencodeClient
        report, code = review(OpencodeClient(timeout=args.attempt_timeout))
    else:
        import cloud
        import config as cfg_mod
        import glm_mode
        from store import DB_PATH, Store
        if not DB_PATH.exists():
            print(f"нет {DB_PATH} — квота и бюджет не видны; запускайте из основного checkout", file=sys.stderr)
            return EXIT_START
        cfg = cfg_mod.load(HERE / "config.toml", strict=False)
        with Store() as store:
            client = cloud.build(cfg, store=store, logger=lambda m: print(m, flush=True))
            glm_mode.apply_budget(client, cfg, True)      # лимиты режима GLM 5.x; платный контур закрыт
            client.max_retries = max(args.attempts, 1) - 1
            for node in client.providers.values():
                node["timeout"] = args.attempt_timeout
            report, code = review(client)
    report["_meta"].update(repo=repo, attempts=args.attempts, attempt_timeout=args.attempt_timeout,
                           chunk_chars=args.chunk_chars, skipped_generated=skipped)
    save(report)
    meta = report["_meta"]
    print(f"\nитог: {sum(1 for k, v in report.items() if k != '_meta' and v['ok'])}/{len(per_lens)} линз прошли"
          + (f"; остановлено — {meta['stopped']}" if meta["stopped"] else ""))
    if meta["not_passed"]:
        nxt = "GLM (review_chain.sh)" if args.backend == "opencode" else "Claude, не больше 2 линз-агентов"
        print(f"не пройдены на {args.backend} (подхватить: {nxt}): " + "; ".join(meta["not_passed"]))
    return code


if __name__ == "__main__":
    sys.exit(main())

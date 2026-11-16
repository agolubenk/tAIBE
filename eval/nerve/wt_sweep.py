# -*- coding: utf-8 -*-
"""Повторная уборка worktree влитых PR (OPS-81, продолжение OPS-52).

После мёржа Нерв один раз зовёт `wt_gc.py branch` (gh_source._gc_worktree). Worktree, в котором работали меньше часа
назад или работал процесс, остаётся, и к нему больше никто не возвращается. Здесь — тот же `wt_gc.py sweep` раз в
SWEEP_MINUTES на продукт, в проходе GitHub: правила безопасности — его (без --force, ветки остаются, грязные и ушедшие
дальше головы PR копии не трогаются).

- Ветки открытых PR (из списка этого же прохода) идут в --skip: ветку взяли заново — worktree не трогается.
- Один вызов gh на продукт за проход: `gh pr list --state merged --limit LIMIT` внутри sweep.
- Удалён — запись в журнал без доставки. Оставлен — координатору под тем же ключом, что и отказ после мёржа
  (`wt:gc:<PR>:<путь>`): журнал не пишет ключ дважды, поэтому координатор получает об этом worktree одно событие.
- Сбой уборки не валит проход GitHub: координатору одно событие в сутки.
"""
import json
import os
import sys
from datetime import timedelta

import sources
from journal import DIGEST

WT_GC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "wt_gc.py")
SWEEP_MINUTES = 60   # окно простоя wt_gc.ACTIVE_S — тоже час: оставленный «работали N мин назад» уходит следующим проходом
LIMIT = 200          # окно последних мёржей: worktree старше — дело ручного `wt_gc.py sweep` (окно 2000)
BUDGET_S = 45        # после него новое удаление не начинается; вызов ждём до 300 с, одно удаление — до 240 с


def due(ctx):
    """Пора ли проход: прошло SWEEP_MINUTES с прошлого. Продукт меняет период полем `github.wt_sweep_minutes` в
    instances/<slug>.json (PRODUCT, products.py; у продукта по умолчанию его выносит в config.json `render`).
    0, не число или нет repo_root — выключено: удаление не начинается, проход GitHub не падает."""
    every = (ctx.cfg.get("github") or {}).get("wt_sweep_minutes", SWEEP_MINUTES)
    if isinstance(every, bool) or not isinstance(every, (int, float)) or every <= 0 or not ctx.cfg.get("repo_root"):
        return False
    last = sources._ts(ctx.state.get("wt_sweep", {}).get("at", ""))
    return last is None or ctx.now - last >= timedelta(minutes=every)


def poll(ctx, open_branches):
    """Проход уборки, если пора. open_branches — ветки открытых PR этого прохода. Исключения не выпускает."""
    if not due(ctx):
        return
    ctx.state["wt_sweep"] = {"at": ctx.now.strftime("%Y-%m-%dT%H:%M:%SZ")}  # и при сбое: повтор — через час
    cmd = [sys.executable, "-I", WT_GC, "sweep", ctx.cfg["repo_root"], "--json", "--limit", str(LIMIT),
           "--budget", str(BUDGET_S)]
    for b in sorted(open_branches):
        cmd += ["--skip", b]
    try:
        code, out, err = sources.run(cmd, timeout=300)
        res = json.loads(out) if code == 0 and out else None
    except Exception as e:  # noqa: BLE001 — таймаут или сбой разбора: только событие
        res, err = None, str(e)
    if res is None:
        ctx.emit(f"wt:sweep:fail:{ctx.now:%Y-%m-%d}", "wt.gc", DIGEST, ["coord"],
                 f"повторная уборка worktree не удалась: {(err or '')[:120]} — wt_gc.py sweep", "github")
        return
    for r in res:
        n = r.get("pr") or "?"
        if r["removed"]:
            ctx.emit(f"wt:sweep:{n}:{r['path']}", "wt.gc", DIGEST, [],
                     f"#{n}: worktree {r['path']} удалён повторной уборкой", "github")
        else:
            ctx.emit(f"wt:gc:{n}:{r['path']}", "wt.gc", DIGEST, ["coord"],
                     f"#{n} влит, worktree {r['path']} оставлен — {r['reason']}", "github")

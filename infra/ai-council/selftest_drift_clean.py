#!/usr/bin/env python3
"""AI Council — самопроверка дрейфа M7 (council_clean.py, §17.9). Только stdlib, сети и Ollama нет.

Вызывается из selftest.py: маска — не путь и не выдумка (снимается с привязок до верификатора, реальный файл со
скобками в имени не снимается); pytest/jest/mocha при TS-файлах пакетов → turbo по пакетам (test:run, иначе
typecheck), при затронутом Python — исходная команда плюс turbo; правки видны в removed_by_verifier слияния.
"""
from __future__ import annotations

import contextlib
import copy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

F1 = "infra/ai-council/council.py"
FRONT, BACK, RPC = "apps/frontend/src/App.tsx", "apps/backend/src/main.ts", "packages/rpc/src/index.ts"
MASK = "apps/backend/**/*.spec.ts"


def _payload(files: list, cmd: str) -> dict:
    return {"goal": "поправить", "decomposition": [{"id": "s1", "what": "шаг", "files": list(files), "est": "S",
                                                    "from": ["p1"]}],
            "touched": {"files": list(files), "routes": [], "prisma_models": [], "rpcs": [], "modules": []},
            "acceptance": ["работает"], "verification_cmd": cmd, "open_questions": [], "confidence": 0.8}


class _NoClient:
    request_timeout = 300

    def chat(self, *_a, **_kw):
        raise AssertionError("M7 не должен звать модели")

    def large_model(self, _model):
        return contextlib.nullcontext()


def _units(check, cc) -> None:
    check("M7: маски — не пути", cc.is_mask(MASK) and cc.is_mask("*.spec.ts") and cc.is_mask("apps/frontend/src/{a,b}.ts")
          and not cc.is_mask(F1) and not cc.is_mask("apps/backend/src/nope.service.ts"))
    payload = _payload([F1, MASK], "turbo run typecheck --filter=@hr-helper/web")
    payload["decomposition"][0]["files"] = ["*.spec.ts", F1]
    removed = cc.strip_masks(payload)
    check("M7: маски сняты из touched и пунктов, настоящий путь остался", removed == [MASK, "*.spec.ts"]
          and payload["touched"]["files"] == [F1] and payload["decomposition"][0]["files"] == [F1], str(removed))
    turbo = cc.turbo_command([FRONT, BACK, RPC, F1, "packages/dto/src/index.ts"])
    check("M7: turbo по пакетам — test:run, где он есть, иначе typecheck; Python и пакеты без задач — мимо",
          turbo == "turbo run test:run --filter=@hr-helper/nestjs-api-v2 --filter=@hr-helper/web"
                   " && turbo run typecheck --filter=@hr-helper/rpc", turbo)
    ts = _payload([FRONT], "pytest apps/frontend/src/App.test.tsx")
    note = cc.fix_verification_cmd(ts)
    check("M7: pytest при TS-файле фронта → turbo test:run", ts["verification_cmd"] ==
          "turbo run test:run --filter=@hr-helper/web" and note.startswith("verification_cmd: «pytest"), note)
    mixed = _payload([F1, BACK], "pytest infra/ai-council")
    cc.fix_verification_cmd(mixed)
    check("M7: затронут и Python — исходная команда остаётся, turbo добавляется",
          mixed["verification_cmd"] == "pytest infra/ai-council && turbo run test:run --filter=@hr-helper/nestjs-api-v2",
          mixed["verification_cmd"])
    keep = [_payload([F1], "npx jest"), _payload([FRONT], "turbo run typecheck --filter=@hr-helper/web")]
    before = copy.deepcopy(keep)
    check("M7: без TS-файлов или с правильной командой — не трогаем",
          [cc.fix_verification_cmd(p) for p in keep] == ["", ""] and keep == before)


def _council_paths(check, tmp: Path, cc) -> None:
    import config as config_mod
    import council as council_mod
    from store import Store
    cfg = config_mod.load(HERE / "config.toml", strict=False)
    cfg.data.setdefault("sources", {}).setdefault("rag", {})["db"] = str(tmp / "no-rag.db")
    store = Store(tmp / "m7.db")
    council = council_mod.Council(cfg, store, _NoClient(), retriever=None, logger=lambda _m: None)
    raw = _payload([F1, MASK], "turbo run typecheck --filter=@hr-helper/web")
    vetoed = council.verifier.verify(copy.deepcopy(raw), "до")
    proposal = council_mod.Proposal("p1", "proposer.code", "m", copy.deepcopy(raw))
    store.x("INSERT INTO runs (id, card_id, status) VALUES ('run-m7', 'c-m7', 'running')")
    council.verify("run-m7", [proposal])
    check("M7: маска больше не выдумка с правом вето (было 1, стало 0)",
          [c.ref for c in vetoed.hallucinations] == [MASK] and not proposal.verification.hallucinations,
          f"{[c.ref for c in vetoed.hallucinations]} → {[c.ref for c in proposal.verification.hallucinations]}")
    merged = _payload([BACK, MASK], "npx jest apps/backend/src/main.spec.ts")
    merged["abstain"] = False
    merged, removed, _ver, _ready, _conf = council._finalize(merged, [proposal])
    check("M7: в слиянии снятая маска и заменённая команда — в removed_by_verifier",
          f"маска, не путь: {MASK}" in removed and any(r.startswith("verification_cmd: «npx jest") for r in removed)
          and merged["verification_cmd"] == "turbo run test:run --filter=@hr-helper/nestjs-api-v2", str(removed))
    council.close()
    store.close()


# Пакеты монорепо, по которым M7 строит turbo-команду, и настоящий путь F1. Проверка всегда идёт на этом дереве, а не
# на checkout хоста (OPS-48): в доме слоя пакетов нет, в другом хосте может не быть F1 — итог не должен от этого
# зависеть. MASK в дереве нет, поэтому она остаётся маской.
HOST_PACKAGES = {
    "apps/frontend": {"name": "@hr-helper/web", "scripts": {"test:run": "vitest run", "typecheck": "tsc"}},
    "apps/backend": {"name": "@hr-helper/nestjs-api-v2", "scripts": {"test:run": "vitest run", "typecheck": "tsc"}},
    "packages/rpc": {"name": "@hr-helper/rpc", "scripts": {"typecheck": "tsc"}},
    "packages/dto": {"name": "@hr-helper/dto", "scripts": {}},
}


def tree() -> dict[str, str]:
    import json
    files = {f"{rel}/package.json": json.dumps(data) for rel, data in HOST_PACKAGES.items()}
    files[F1] = ""
    return files


# Читатели корня хоста названы здесь, а не взяты из selftest_tree.READERS. Если модуль пропадёт из READERS, CI без
# TAIBE_HOST_ROOT этого не увидит: в checkout tAIBE есть те же файлы, что в фикстуре (линза boards на #258).
HOST_READERS = ("verifier", "council_rounds", "council_clean")


def run(tmp: Path, check) -> None:
    import importlib
    import council_clean as cc
    from selftest_tree import host_tree
    with host_tree(tmp, tree(), name="m7-host") as root:
        lost = [m for m in HOST_READERS if importlib.import_module(m).REPO_ROOT != root]
        check("M7: verifier, council_rounds и council_clean читают дерево-фикстуру, а не checkout", not lost, str(lost))
        _units(check, cc)
        _council_paths(check, tmp, cc)

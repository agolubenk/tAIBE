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


# Пакеты монорепо, по которым M7 строит turbo-команду. В хосте без них (дом слоя: доски на pnpm, eval на stdlib)
# проверка идёт на фикстуре с теми же package.json, а не молча проходит и не падает на чужом дереве.
HOST_PACKAGES = {
    "apps/frontend": {"name": "@hr-helper/web", "scripts": {"test:run": "vitest run", "typecheck": "tsc"}},
    "apps/backend": {"name": "@hr-helper/nestjs-api-v2", "scripts": {"test:run": "vitest run", "typecheck": "tsc"}},
    "packages/rpc": {"name": "@hr-helper/rpc", "scripts": {"typecheck": "tsc"}},
    "packages/dto": {"name": "@hr-helper/dto", "scripts": {}},
}


def _fixture_host(tmp: Path) -> Path:
    import json
    root = tmp / "m7-host"
    for rel, data in HOST_PACKAGES.items():
        (root / rel).mkdir(parents=True, exist_ok=True)
        (root / rel / "package.json").write_text(json.dumps(data), encoding="utf-8")
    return root


def run(tmp: Path, check) -> None:
    import council_clean as cc
    real_root = cc.REPO_ROOT
    if not all((real_root / rel / "package.json").exists() for rel in HOST_PACKAGES if rel != "packages/dto"):
        cc.REPO_ROOT = _fixture_host(tmp)
        cc._package.cache_clear()
    try:
        _units(check, cc)
        _council_paths(check, tmp, cc)
    finally:
        cc.REPO_ROOT = real_root
        cc._package.cache_clear()

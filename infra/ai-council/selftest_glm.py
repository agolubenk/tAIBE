#!/usr/bin/env python3
"""AI Council — самопроверка режима «всё на GLM 5.x» (§17.6, glm_mode.py). Только stdlib.

Вызывается из selftest.py (`test_glm_mode`) — вынесено, чтобы не раздувать общий файл; прогоны
в режиме (ревью, проработка, судья тупика) — в selftest_glm_runs.py. Сети не трогает: облачный
вызов отклоняется бюджетом ДО HTTP, а где он должен пройти — `chat` клиента подменён; GET
/models и живые чат-вызовы — не дело самопроверки. Боевую БД не трогает: только временные.
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod          # noqa: E402
from store import Store              # noqa: E402

PAID = {"label": "General API (платный)", "base_url": "https://example.invalid/api/paas/v4",
        "key": "fb-test", "when": ["quota", "no_balance"], "max_calls_per_day": 10,
        "max_usd_per_day": 1.0, "pricing": {"glm-5.2": {"in_per_mtok": 1.5, "out_per_mtok": 6.0}}}


def run(tmp: Path, check) -> None:
    import cloud as cloud_mod
    import glm_mode

    base = (HERE / "config.toml").read_text(encoding="utf-8")
    cfg = config_mod.load(HERE / "config.toml", strict=False)
    g = glm_mode.settings(cfg)

    _roster(cfg, g, check, glm_mode)
    prev_env = os.environ.get("AI_COUNCIL_CLOUD")
    db = tmp / "glm.db"
    try:
        with Store(db) as store:
            client = cloud_mod.build(cfg, store)
            client.profile = "hybrid"
            base_window = client.budget.max_calls_per_window
            _budget(cfg, g, check, glm_mode, client)
            _paid_contour(cfg, check, glm_mode, client)
            _switch_and_queue(check, glm_mode, store)
            _preflight(cfg, check, glm_mode, client, store)
            _worker_tick(cfg, g, check, glm_mode, store, client)
        _gateway(cfg, g, check, db, base_window)
        import selftest_glm_runs       # ревью и проработки в режиме — отдельный файл (лимит 500 строк)
        selftest_glm_runs.run(tmp, check, cfg)
        import selftest_glm_quota      # квота подписки (1308/1310): прогоны ждут сброса
        selftest_glm_quota.run(tmp, check, cfg)
        import selftest_glm_empty      # пустой ответ GLM: отказ с finish_reason (OPS-47)
        selftest_glm_empty.run(tmp, check, cfg)
    finally:
        if prev_env is None:
            os.environ.pop("AI_COUNCIL_CLOUD", None)
        else:
            os.environ["AI_COUNCIL_CLOUD"] = prev_env
    _validator(tmp, base, g, check)


# ── ростер: каждая роль, кроме embed, — модель 5.x своей роли ───────────────
def _roster(cfg, g, check, glm_mode) -> None:
    roster = cfg.roles("deep")
    over = glm_mode.roles_override(cfg, roster)
    check("GLM 5.x: embed остаётся локальным (у Coding API нет эмбеддингов)",
          over.get("embed") == roster.get("embed"), over.get("embed"))
    zai = set(cfg.get("models.cloud.providers.zai.models") or [])
    cloud_roles = {r: m for r, m in over.items() if r != "embed"}
    check("GLM 5.x: все прочие роли — модели 5.x подписки zai",
          set(cloud_roles) == set(roster) - {"embed"}
          and all(m in zai and m.startswith("glm-5") for m in cloud_roles.values()), cloud_roles)
    proposers = [m for r, m in over.items() if r.startswith("proposer.")]
    check("GLM 5.x: proposer.* на разных моделях (иначе независимых мнений нет)",
          len(proposers) == 3 and len(set(proposers)) == 3, proposers)
    check("GLM 5.x: critic(роль) — моделью роли, неизвестная роль (агент ревью) → default",
          glm_mode.model_for(cfg, "critic(proposer.arch)") == g["models"]["proposer.arch"]
          and glm_mode.model_for(cfg, "agent.security") == g["models"]["default"])
    check("GLM 5.x: ростер профиля не расширяется (fast — без скептика)",
          set(glm_mode.roles_override(cfg, cfg.roles("fast"))) == set(cfg.roles("fast")))


# ── бюджет: лимиты режима, пока он действует; выключили — снова общие ────────
def _budget(cfg, g, check, glm_mode, client) -> None:
    base_window, base_allow = client.budget.max_calls_per_window, client.run_allowance()
    glm_mode.apply_budget(client, cfg, True)
    b = client.budget
    check("GLM 5.x: включён — окно, сутки и потолок на прогон из models.glm_all",
          (b.max_calls_per_window, b.window_hours, b.max_calls_per_day, client.run_allowance())
          == (g["max_calls_per_window"], g["window_hours"], g["max_calls_per_day"],
              g["max_calls_per_run"]),
          f"{b.max_calls_per_window}/{b.window_hours} ч, {b.max_calls_per_day}/сут, "
          f"{client.run_allowance()}/прогон")
    check("GLM 5.x: по умолчанию 500 вызовов за 10 ч",
          (g["max_calls_per_window"], g["window_hours"]) == (500, 10))
    client.profile = "escalation"
    check("GLM 5.x: потолок на прогон не зависит от профиля бюджета",
          client.run_allowance() == g["max_calls_per_run"])
    glm_mode.apply_budget(client, cfg, False)
    client.profile = "hybrid"
    check("GLM 5.x: выключен — снова [models.cloud.budget]",
          client.budget.max_calls_per_window == base_window
          and client.run_allowance() == base_allow and client.budget.run_cap == 0)

    # Потолок режима на прогон режет обращение ДО сети.
    glm_mode.apply_budget(client, cfg, True)
    client.budget.enabled = True
    client.providers["zai"]["key"] = "test-key"
    client._calls_this_run["run-glm"] = g["max_calls_per_run"]
    res = client.chat("run-glm", "arbiter", g["models"]["arbiter"],
                      [{"role": "user", "content": "x"}])
    check("GLM 5.x: потолок режима на прогон режет обращение до сети",
          not res.ok and "на прогон" in res.error and f"/{g['max_calls_per_run']}" in res.error,
          res.error[:80])
    glm_mode.apply_budget(client, cfg, False)


# ── платный контур: в режиме только подписка ───────────────────────────────
def _paid_contour(cfg, check, glm_mode, client) -> None:
    zai = client.providers["zai"]
    saved = (zai.get("key"), zai.get("fallback"))
    zai["key"], zai["fallback"] = "", dict(PAID)
    try:
        ok_off = client.available("glm-5.2")[0]
        fb_off = client._fallback_allowed("zai", "quota", "glm-5.2")[0]
        glm_mode.apply_budget(client, cfg, True)
        ok_on, why_on = client.available("glm-5.2")
        fb_on, why_fb = client._fallback_allowed("zai", "quota", "glm-5.2")
    finally:
        zai["key"], zai["fallback"] = saved
        glm_mode.apply_budget(client, cfg, False)
    check("GLM 5.x: платный General API в режиме закрыт — нет ключа подписки → отказ с причиной, "
          "квота подписки → без доплаты вторым ключом; вне режима контур прежний",
          ok_off and bool(fb_off) and not ok_on and "только в подписку" in why_on
          and not fb_on and "только в подписку" in why_fb, (why_on[:70], why_fb[:70]))


# ── тумблер шапки ИЛИ отметка задачи; очередь мимо memory-guard ─────────────
def _switch_and_queue(check, glm_mode, store) -> None:
    check("GLM 5.x: по умолчанию выключен",
          not glm_mode.is_on(store) and not glm_mode.wanted(store, None))
    check("GLM 5.x: отметка задачи включает режим только для неё",
          glm_mode.wanted(store, {"cloud_mode": "glm5"}) and not glm_mode.wanted(store, {"cloud_mode": ""})
          and not glm_mode.requested('{"cloud_mode": "glm5"}'))
    glm_mode.set_on(store, True, "selftest")
    check("GLM 5.x: тумблер шапки — режим для любой задачи",
          glm_mode.is_on(store) and glm_mode.wanted(store, {}) and glm_mode.wanted(store))
    glm_mode.set_on(store, False, "selftest")
    check("GLM 5.x: тумблер выключается", not glm_mode.wanted(store, {"cloud_mode": "x"}))

    store.enqueue("card-local", profile="deep", dedupe=False)
    glm_id = store.enqueue("card-glm", profile="deep", dedupe=False, cloud_mode="glm5")
    got = store.claim_run("w-glm", exclude_profiles=["deep"])
    check("GLM 5.x: прогон режима проходит мимо блока памяти профиля, локальный ждёт",
          got is not None and got["id"] == glm_id and got["cloud_mode"] == "glm5"
          and store.claim_run("w-glm", exclude_profiles=["deep"]) is None)


# ── предполётная проверка: не воздерживаться на пустых облачных раундах ─────
def _preflight(cfg, check, glm_mode, client, store) -> None:
    os.environ["AI_COUNCIL_CLOUD"] = "0"
    ok, why, retry = glm_mode.preflight(client, cfg, "run-off")
    check("GLM 5.x: облако выключено — завершить с причиной, локально не подменять",
          not ok and retry == 0 and "облак" in why, why[:80])
    os.environ["AI_COUNCIL_CLOUD"] = "1"
    glm_mode.apply_budget(client, cfg, True)
    client.budget.max_calls_per_window = 41          # один вызов свободен, потолок прогона — нет
    ts = int(time.time())
    for i in range(2):
        store.x("INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, "
                "usd, ms, ok, refused, error, created_at) VALUES (?,?,?,?,0,0,0,0,1,'','',?)",
                (f"r{i}", "arbiter", "zai", "glm-5.2", ts - 60 + i))
    ok1, why1, retry1 = glm_mode.preflight(client, cfg, "run-room")
    check("GLM 5.x: окно не вместит потолок прогона — не начинать, ждать, пока вместит",
          not ok1 and "окно плана" in why1 and retry1 > ts + 3600, f"{why1[:70]} → +{retry1 - ts} с")
    client.budget.max_calls_per_window = 2
    ok, why, retry = glm_mode.preflight(client, cfg, "run-full")
    check("GLM 5.x: окно исчерпано — отложить до его освобождения",
          not ok and "окно плана" in why and retry > ts + 3600, f"{why[:60]} → +{retry - ts} с")
    glm_mode.apply_budget(client, cfg, False)
    store.x("DELETE FROM cloud_usage")


# ── воркер: тумблер на каждом цикле, выключение возвращает отложенных ───────
def _worker_tick(cfg, g, check, glm_mode, store, client) -> None:
    import council_worker as worker
    os.environ["AI_COUNCIL_CLOUD"] = "1"
    glm_mode.set_on(store, True, "selftest")
    was, on = worker._glm_tick(cfg, store, client, None)
    check("GLM 5.x воркер: тумблер подхвачен на следующем цикле без рестарта — лимиты режима",
          was and on and client.budget.glm_mode
          and client.budget.max_calls_per_window == g["max_calls_per_window"])
    later, pre = int(time.time()) + 3600, glm_mode.DEFER_PREFIX + "окно"
    by_switch = store.enqueue("c-sw", profile="deep", dedupe=False)
    marked = store.enqueue("c-mk", profile="deep", dedupe=False, cloud_mode="glm5")
    store.x("UPDATE runs SET not_before=?, error=? WHERE id IN (?, ?)", (later, pre, by_switch, marked))
    for rid, req in (("rv_sw", "{}"), ("rv_mk", '{"cloud_mode": "glm5"}')):
        store.x("INSERT INTO review_runs (id, card_id, board, status, request, error, not_before, "
                "created_at) VALUES (?, ?, 'tasks', 'queued', ?, ?, ?, ?)", (rid, rid, req, pre, later, 1))
    glm_mode.set_on(store, False, "selftest")
    was, on = worker._glm_tick(cfg, store, client, was)
    waits = {r["id"]: r["not_before"] for r in store.q(
        "SELECT id, not_before FROM runs WHERE id IN (?, ?) UNION ALL SELECT id, not_before "
        "FROM review_runs WHERE id IN ('rv_sw', 'rv_mk')", (by_switch, marked))}
    check("GLM 5.x воркер: выключили — отложенные тумблером (проработка и ревью) снова в очереди, "
          "с отметкой ждут окно; лимиты обычные",
          not was and not on and not client.budget.glm_mode
          and waits == {by_switch: None, marked: later, "rv_sw": None, "rv_mk": later}, waits)
    os.environ["AI_COUNCIL_CLOUD"] = "0"
    glm_mode.set_on(store, True, "selftest")
    was, on = worker._glm_tick(cfg, store, client, was)
    check("GLM 5.x воркер: облако выключено — тумблер включён, но не действует, лимиты обычные",
          was and not on and not client.budget.glm_mode and client.budget.run_cap == 0)
    glm_mode.set_on(store, False, "selftest")
    os.environ["AI_COUNCIL_CLOUD"] = "1"
    left = store.enqueue("c-left", profile="deep", dedupe=False)    # отложен тумблером до рестарта
    store.x("UPDATE runs SET not_before=?, error=? WHERE id=?", (later, pre, left))
    worker._glm_tick(cfg, store, client, None)                      # первый цикл нового воркера
    check("GLM 5.x воркер: тумблер выключили, пока воркер стоял, — отложенные им вернутся на старте",
          store.q1("SELECT not_before FROM runs WHERE id=?", (left,))["not_before"] is None)
    store.x("UPDATE runs SET status='cancelled' WHERE status='queued'")
    store.x("UPDATE review_runs SET status='cancelled' WHERE status='queued'")


# ── шлюз: тумблер, отметка задачи, окно в шапке ─────────────────────────────
def _gateway(cfg, g, check, db: Path, base_window: int) -> None:
    import gateway as gw
    api = gw.Api(cfg, db_path=str(db))
    os.environ["AI_COUNCIL_CLOUD"] = "0"
    r_off = api.set_glm(True)
    r_bad = api.enqueue("нет-такой", "fast", cloud_mode="glm5")
    check("GLM 5.x: без облака тумблер и отметка задачи отклоняются",
          not r_off.get("ok") and not r_bad.get("ok") and "облак" in r_bad.get("error", ""))
    os.environ["AI_COUNCIL_CLOUD"] = "1"
    check("GLM 5.x: неизвестный cloud_mode отклоняется",
          "glm5" in (api.enqueue("нет-такой", "fast", cloud_mode="glm4").get("error") or ""))
    r_on = api.set_glm(True)
    c_on = api.cloud()
    api.set_glm(False)
    c_off = api.cloud()
    check("GLM 5.x: окно в шапке — окно режима, пока тумблер включён",
          r_on.get("ok") and c_on["glm"]["effective"]
          and c_on["window"]["max"] == g["max_calls_per_window"]
          and c_off["window"]["max"] == base_window and not c_off["glm"]["on"],
          f"вкл {c_on['window']['max']}/{c_on['window']['hours']} ч, "
          f"выкл {c_off['window']['max']}/{c_off['window']['hours']} ч")
    _settings_guard(cfg, check, gw, api, db.parent)


def _settings_guard(cfg, check, gw, api, tmp: Path) -> None:
    """Правка лимитов режима из UI — под валидатором. Пишется КОПИЯ конфига во временном
    каталоге (CONFIG_PATH и config.load подменены): config.toml репозитория не трогается."""
    real = HERE / "config.toml"
    real_before = real.read_bytes()
    root = tmp / "settings-root"
    target = root / "infra/ai-council/config.toml"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(real_before)
    orig_path, orig_load = config_mod.CONFIG_PATH, config_mod.load
    config_mod.CONFIG_PATH = target
    config_mod.load = lambda path=None, strict=True: orig_load(target, strict)
    try:
        api.cfg = config_mod.load(strict=False)
        bad = api.update_setting("models.glm_all.max_calls_per_day", 10)
        kept = target.read_bytes() == real_before
        good = api.update_setting("models.glm_all.max_calls_per_window", 450)
        applied = "max_calls_per_window = 450" in target.read_text(encoding="utf-8")
    finally:
        config_mod.CONFIG_PATH, config_mod.load = orig_path, orig_load
        api.cfg = cfg
    check("GLM 5.x: правка лимитов из UI под валидатором — сутки ниже окна откатываются, "
          "допустимая правка применяется; config.toml репозитория не тронут",
          not bad.get("ok") and "окно никогда не сработает" in bad.get("error", "") and kept
          and good.get("ok") and applied and real.read_bytes() == real_before,
          (bad.get("error", "")[:90], good.get("ok")))


# ── валидатор: только 5.x подписки zai, сутки ≥ окна, embed не трогать ──────
def _validator(tmp: Path, base: str, g: dict, check) -> None:
    def problems_with(patched: str) -> list[str]:
        path = tmp / f"glm_cfg_{abs(hash(patched)) % 10**8}.toml"
        path.write_text(patched, encoding="utf-8")
        return [p for p in getattr(config_mod.load(path, strict=False), "problems", [])
                if "glm_all" in p]

    check("GLM 5.x: боевой models.glm_all валиден", not problems_with(base), problems_with(base))
    # Строки берутся из самого конфига (урок B-61: буквальный шаблон протухает молча).
    block = re.search(r"(?ms)^\[models\.glm_all\.models\]\n.*?(?=^\[|\Z)", base)
    assert block, "config.toml: нет [models.glm_all.models] — тест протух"
    arbiter = re.search(r'^"arbiter"\s*=\s*"[^"]+"', block.group(0), re.M).group(0)
    arch = re.search(r'^"proposer\.arch"\s*=\s*"[^"]+"', block.group(0), re.M).group(0)

    def patch_block(old: str, new: str) -> str:
        return base[:block.start()] + block.group(0).replace(old, new) + base[block.end():]

    check("GLM 5.x: модель не 5-го поколения ловится",
          any("5-го поколения" in p
              for p in problems_with(patch_block(arbiter, '"arbiter" = "glm-4.6"'))))
    check("GLM 5.x: 5.x, не объявленная у zai, ловится",
          any("zai.models" in p
              for p in problems_with(patch_block(arbiter, '"arbiter" = "glm-5.9"'))))
    check("GLM 5.x: одна модель на двух proposer.* ловится",
          any("независимых мнений" in p for p in problems_with(
              patch_block(arch, f'"proposer.arch" = "{g["models"]["proposer.code"]}"'))))
    check("GLM 5.x: embed в карте режима ловится",
          any("эмбеддинги" in p
              for p in problems_with(patch_block(arbiter, arbiter + '\n"embed" = "glm-5"'))))
    day = re.search(r"(?ms)^\[models\.glm_all\][^\[]*?^max_calls_per_day\s*=\s*(\d+)", base)
    assert day, "config.toml: max_calls_per_day не найден в [models.glm_all] — тест протух"
    check("GLM 5.x: суточный лимит ниже оконного ловится",
          any("окно никогда не сработает" in p
              for p in problems_with(base[:day.start(1)] + "10" + base[day.end(1):])))
    run = re.search(r"(?ms)^\[models\.glm_all\][^\[]*?^max_calls_per_run\s*=\s*(\d+)", base)
    assert run, "config.toml: max_calls_per_run не найден в [models.glm_all] — тест протух"
    check("GLM 5.x: потолок прогона больше окна ловится (прогон ждал бы пустого окна)",
          any("ждал бы пустого окна" in p
              for p in problems_with(base[:run.start(1)] + "100000" + base[run.end(1):])))

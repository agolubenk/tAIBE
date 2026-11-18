"""OPS-25 Ф1: instances/ → config.json байт-в-байт; поля на своих местах; ошибки с файлом и полем."""
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import products as P  # noqa: E402
import sources  # noqa: E402


def copy_instances():
    d = tempfile.mkdtemp(prefix="instances-")
    for name in os.listdir(P.INSTANCES):
        shutil.copy(os.path.join(P.INSTANCES, name), d)
    return d


def _at(data, keys):
    for k in keys:
        data = data[k]
    return data


def edit(d, name, fn):
    path = os.path.join(d, name)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    fn(data)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class RenderTest(unittest.TestCase):
    def test_config_is_rendered_byte_for_byte(self):
        with open(P.CONFIG, encoding="utf-8") as f:
            self.assertEqual(P.render_text(), f.read())

    def test_check_passes_on_the_repo(self):
        self.assertEqual(P.main(["render", "--check"]), 0)

    def test_taibe_is_active_since_f4(self):
        shared, products = P.load()
        self.assertEqual(shared["default_product"], "hr-helper")
        self.assertIs(products["taibe"]["active"], True)
        cfg = P.config_for("taibe", shared, products)
        self.assertEqual(cfg["github"]["repo"], "agolubenk/tAIBE")
        self.assertEqual(cfg["team"]["projects_root"], shared["team"]["projects_root"], "слияние не теряет общий лист")
        self.assertEqual(cfg["queue"]["match"], r"-taibe(-|\d|$)")

    def test_taibe_match_catches_label_without_hyphen(self):
        """SE-109: `m-taibe310-1411` — пункт tAIBE; `d-hr-…`, `d-taibeta-1` — нет."""
        match = re.compile(P.config_for("taibe")["queue"]["match"])
        for item_id in ("m-taibe310-1411", "d-taibe-x", "s-restart-4-taibe-1211", "s-restart-taibe"):
            self.assertTrue(match.search(item_id), item_id)
        for item_id in ("d-hr-x-1411", "d-1", "d-taibeta-1", "taibe-m-93"):
            self.assertFalse(match.search(item_id), item_id)

    def test_taibe_answer_on_a_role_6_item_goes_to_boards(self):
        """SE-99: «boards» и «роль 6» в source — роль boards, если раньше не совпало слово другой роли (правило
        последнее). Источники — из живой очереди 14.11; прочие — как до правки."""
        rules = P.config_for("taibe")["queue"]["source_roles"]
        cases = {"boards (роль 6)": "boards", "taibe boards r.37tl": "boards", "Инструменты — boards": "boards",
                 "роль 6 boards, r.7hxk.2y32": "boards", "backup-pull-mac-12 (роль 6, автор #544)": "boards",
                 "t-boards (роль 6)": "boards",
                 "coord r.sio1 / boards r.ngjc (APP-580)": "coord", "t3-coord (роль 1) по просьбе t3-boards": "coord",
                 "copilot-tboards-migration": "coord", "Координатор r.x": "coord", "release r.x": "release",
                 "backend r.x": "backend", "frontend r.x": "frontend", "plan r.x": "plan", "taibe-59": "coord"}
        self.assertEqual({s: sources.route_source(s, rules) for s in cases}, cases)


class GetTest(unittest.TestCase):
    def test_get_field_and_default(self):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(P.main(["get", "default", "slug"]), 0)
            self.assertEqual(P.main(["get", "taibe", "github.repo"]), 0)
            self.assertEqual(P.main(["get", "taibe", "active"]), 0)
        self.assertEqual(out.getvalue().split(), ["hr-helper", "agolubenk/tAIBE", "true"])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(P.main(["get", "taibe", "no.such"]), 1)


class ErrorsTest(unittest.TestCase):
    def setUp(self):
        self.d = copy_instances()
        self.addCleanup(shutil.rmtree, self.d)

    def fails(self, text):
        with self.assertRaises(P.ProductError) as e:
            P.load(self.d)
        self.assertIn(text, str(e.exception))

    def test_leaf_in_both_files(self):
        edit(self.d, "_shared.json", lambda d: d["team"].update(project_dir="/x"))
        self.fails("team.project_dir")

    def test_mac_field_in_product(self):
        edit(self.d, "taibe.json", lambda d: d.update(interval_seconds=5))
        self.fails("instances/_shared.json")

    def test_secret_like_value(self):
        edit(self.d, "taibe.json", lambda d: d.update(title="ghp_" + "a" * 36))
        self.fails("похоже на ключ")

    def test_foreign_role_in_path_roles(self):
        edit(self.d, "taibe.json", lambda d: d["github"]["path_roles"].append(["x/", "chef"]))
        self.fails("chef")

    def test_second_session_needs_its_base_role(self):
        edit(self.d, "taibe.json", lambda d: d["team"]["roles"].remove("backend"))
        self.fails("вторая сессия «backend-2» без роли «backend»")

    def test_second_session_of_unknown_role(self):
        edit(self.d, "taibe.json", lambda d: d["team"]["roles"].append("chef-2"))
        self.fails("chef")

    def test_bad_slug(self):
        os.rename(os.path.join(self.d, "taibe.json"), os.path.join(self.d, "HR_Helper.json"))
        self.fails("slug")

    def test_queue_match_must_be_a_regex(self):
        """SE-109: битое `queue.match` — ошибка загрузки с файлом и полем, а не тихий обход маршрута."""
        edit(self.d, "taibe.json", lambda d: d["queue"].update(match="-taibe("))
        self.fails("queue.match")

    def test_queue_match_matching_the_empty_string_is_refused(self):
        """SE-117: такое выражение совпадает с любым id — все пункты очереди ушли бы в tAIBE."""
        for match in ("taibe|", "(-taibe)?", "^", "-taibe|$"):
            with self.subTest(match=match):
                edit(self.d, "taibe.json", lambda d, m=match: d["queue"].update(match=m))
                self.fails("совпадает с пустой строкой")
        edit(self.d, "taibe.json", lambda d: d["queue"].update(match="-taibe(-|\\d|$)"))
        P.load(self.d)

    def test_queue_match_must_be_a_string(self):
        edit(self.d, "taibe.json", lambda d: d["queue"].update(match=["-taibe-"]))
        self.fails("queue.match")

    def test_empty_required_string_is_refused(self):
        """SE-172: пустая строка в обязательном поле — ошибка загрузки, а не "" с кодом 0 у `get` (линза #218)."""
        for path in ("repo_root", "product_tree", "team.project_dir", "github.repo"):
            for value in ("", "  "):
                with self.subTest(path=path, value=value):
                    d = copy_instances()
                    self.addCleanup(shutil.rmtree, d)
                    *keys, leaf = path.split(".")
                    edit(d, "taibe.json", lambda data, k=keys, lf=leaf, v=value: _at(data, k).update({lf: v}))
                    with self.assertRaises(P.ProductError) as e:
                        P.load(d)
                    self.assertIn(f"instances/taibe.json: пустое обязательное поле {path}", str(e.exception))

    def test_get_of_empty_required_field_fails(self):
        import contextlib
        import io
        edit(self.d, "taibe.json", lambda d: d.update(repo_root=""))
        err = io.StringIO()
        real = P.load
        with mock.patch.object(P, "load", lambda instances=self.d: real(instances)), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(err):
            self.assertEqual(P.main(["get", "taibe", "repo_root"]), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("пустое обязательное поле repo_root", err.getvalue())

    def test_unknown_default(self):
        edit(self.d, "_shared.json", lambda d: d.update(default_product="nope"))
        self.fails("default_product")

    def test_wt_sweep_switch_is_a_product_field(self):
        """OPS-81 (линза плана #445): выключатель повторной уборки — поле продукта; файл читается, поле доходит до
        конфига продукта и до config.json продукта по умолчанию, и проход уборки выключен. В _shared — ошибка."""
        import wt_sweep
        for name in ("taibe.json", "hr-helper.json"):
            edit(self.d, name, lambda d: d["github"].update(wt_sweep_minutes=0))
        shared, products = P.load(self.d)
        for slug in ("taibe", "hr-helper"):
            cfg = P.config_for(slug, shared, products)
            self.assertEqual(cfg["github"]["wt_sweep_minutes"], 0)
            self.assertFalse(wt_sweep.due(type("Ctx", (), {"cfg": cfg, "state": {}})()))
        self.assertEqual(json.loads(P.render_text(shared, products))["github"]["wt_sweep_minutes"], 0)
        edit(self.d, "_shared.json", lambda d: d.setdefault("github", {}).update(wt_sweep_minutes=0))
        self.fails("wt_sweep_minutes")

    def test_paths_are_not_secrets(self):
        self.assertIsNone(P.SECRET_RE.search("/Users/agolubenko/Desktop/Development/tAIBE/eval/nerve/state"))


class BaseRoleTest(unittest.TestCase):
    def test_second_session_maps_to_base_role(self):
        self.assertEqual([P.base_role(r) for r in ("backend-2", "frontend-2", "backend", "boards", "a-1", "x-10", "")],
                         ["backend", "frontend", "backend", "boards", "a-1", "x-10", ""])

    def test_both_products_have_second_sessions_after_the_six(self):
        """Решения владельца 14.11: backend-2 (роль 7) и frontend-2 (роль 8) у tAIBE и HR."""
        _, products = P.load()
        for slug in ("taibe", "hr-helper"):
            self.assertEqual(products[slug]["team"]["roles"][6:], ["backend-2", "frontend-2"], slug)


class ProductDirTest(unittest.TestCase):
    def test_default_stays_in_place_others_go_under_products(self):
        self.assertEqual(P.product_dir("hr-helper", "/s", "hr-helper"), "/s")
        self.assertEqual(P.product_dir("taibe", "/s", "hr-helper"), os.path.join("/s", "products", "taibe"))
        with self.assertRaises(P.ProductError):
            P.product_dir("../x", "/s", "hr-helper")


if __name__ == "__main__":
    unittest.main()

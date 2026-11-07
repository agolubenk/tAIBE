"""OPS-25 Ф1: instances/ → config.json байт-в-байт; поля на своих местах; ошибки с файлом и полем."""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import products as P  # noqa: E402


def copy_instances():
    d = tempfile.mkdtemp(prefix="instances-")
    for name in os.listdir(P.INSTANCES):
        shutil.copy(os.path.join(P.INSTANCES, name), d)
    return d


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

    def test_taibe_is_inactive_until_f4(self):
        shared, products = P.load()
        self.assertEqual(shared["default_product"], "hr-helper")
        self.assertIs(products["taibe"]["active"], False)
        cfg = P.config_for("taibe", shared, products)
        self.assertEqual(cfg["github"]["repo"], "agolubenk/tAIBE")
        self.assertEqual(cfg["team"]["projects_root"], shared["team"]["projects_root"], "слияние не теряет общий лист")
        self.assertEqual(cfg["queue"]["match"], "-taibe-")


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

    def test_bad_slug(self):
        os.rename(os.path.join(self.d, "taibe.json"), os.path.join(self.d, "HR_Helper.json"))
        self.fails("slug")

    def test_unknown_default(self):
        edit(self.d, "_shared.json", lambda d: d.update(default_product="nope"))
        self.fails("default_product")

    def test_paths_are_not_secrets(self):
        self.assertIsNone(P.SECRET_RE.search("/Users/agolubenko/Desktop/Development/tAIBE/eval/nerve/state"))


class ProductDirTest(unittest.TestCase):
    def test_default_stays_in_place_others_go_under_products(self):
        self.assertEqual(P.product_dir("hr-helper", "/s", "hr-helper"), "/s")
        self.assertEqual(P.product_dir("taibe", "/s", "hr-helper"), os.path.join("/s", "products", "taibe"))
        with self.assertRaises(P.ProductError):
            P.product_dir("../x", "/s", "hr-helper")


if __name__ == "__main__":
    unittest.main()

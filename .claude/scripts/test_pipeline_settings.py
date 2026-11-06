#!/usr/bin/env python3
"""pipeline_settings.py: same keys as the board, env override, cache, fetch from a local fake board, outage keeps
the last known switches. Run: python3 -I .claude/scripts/test_pipeline_settings.py"""
import http.server
import json
import os
import re
import shutil
import ssl
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pipeline_settings as ps  # noqa: E402

TS = os.path.join(HERE, '..', '..', 'boards', 'packages', 'permissions', 'src', 'pipeline-toggles.ts')
SHIPPED = os.path.join(HERE, '..', '..', 'eval', 'nerve', 'config.json')


FULL = {'automation': True, 'toggles': {name: True for name in ps.TOGGLES}}  # the owner turned everything on


class Board(http.server.BaseHTTPRequestHandler):
    body = {}
    seen = []
    redirect = None
    missing = set()
    workspaces = [{'id': 'ws 1', 'name': 'tAIBE', 'slug': 'taibe'}]

    def do_GET(self):  # noqa: N802
        Board.seen.append((self.path, self.headers.get('x-api-key')))
        if Board.redirect:
            self.send_response(302)
            self.send_header('location', Board.redirect)
            self.end_headers()
            return
        if self.path in Board.missing:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(Board.workspaces if self.path == '/api/workspace' else Board.body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class PipelineSettingsTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, '.claude'))
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for k in ('TAIBE_PIPELINE', 'T_BOARDS_URL', 'T_BOARDS_API_KEY', 'T_BOARDS_PIPELINE_KEY', 'T_BOARDS_WORKSPACE',
                  'T_BOARDS_PRODUCT', 'T_BOARDS_ALLOWED_HOSTS'):
            os.environ.pop(k, None)
        Board.redirect, Board.seen, Board.missing = None, [], set()
        Board.workspaces = [{'id': 'ws 1', 'name': 'tAIBE', 'slug': 'taibe'}]
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Board)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = 'http://127.0.0.1:%d' % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.env.stop()
        shutil.rmtree(self.root)

    @unittest.skipUnless(os.path.isfile(TS), 'boards not in this tree')
    def test_keys_match_the_board(self):
        with open(TS, encoding='utf-8') as f:
            board = re.findall(r'^\s+(\w+): \{ group: "', f.read(), re.M)
        self.assertEqual(sorted(board), sorted(ps.TOGGLES))

    def connect(self, body=None):
        Board.body = body if body is not None else dict(FULL, toggles=dict(FULL['toggles'], councilReview=False))
        os.environ.update({'T_BOARDS_URL': self.url, 'T_BOARDS_PIPELINE_KEY': 'k-1', 'T_BOARDS_WORKSPACE': 'ws 1'})

    def age_cache(self, seconds):
        path = os.path.join(self.root, ps.CACHE)
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        for k in ('fetchedAt', 'lastAttempt'):
            if data.get(k):
                data[k] -= seconds
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def test_defaults_and_env_only_switches_off(self):
        self.assertTrue(ps.enabled('swarm', self.root))
        os.environ['TAIBE_PIPELINE'] = 'off'
        self.assertFalse(ps.enabled('swarm', self.root))
        os.environ['TAIBE_PIPELINE'] = 'swarm=off,abJudge=off,bogus=off'
        self.assertFalse(ps.enabled('swarm', self.root))
        self.assertFalse(ps.enabled('abJudge', self.root))
        self.assertTrue(ps.enabled('askOnce', self.root))
        self.assertTrue(ps.enabled('notAToggle', self.root))  # unknown → on
        self.assertFalse(ps.enabled('abJudgeClaude', self.root))  # default off: the owner's tokens
        # The owner switched councilReview off on the board: no env value turns it back on.
        self.connect()
        for value in ('on', 'councilReview=on', 'swarm=off'):
            os.environ['TAIBE_PIPELINE'] = value
            self.assertFalse(ps.enabled('councilReview', self.root), value)

    def test_fetch_cache_outage_and_backoff(self):
        self.connect()
        self.assertFalse(ps.enabled('councilReview', self.root))  # cache missing → fetched now
        self.assertEqual(Board.seen[-1], ('/api/pipeline-settings/workspace/ws%201', 'k-1'))  # id escaped
        self.assertEqual(os.stat(os.path.join(self.root, ps.CACHE)).st_mode & 0o777, 0o600)
        calls = len(Board.seen)
        self.assertFalse(ps.enabled('councilReview', self.root))
        self.assertEqual(len(Board.seen), calls)  # fresh cache → no second request
        # The board goes away and the cache is old: the owner's «off» stays off, and the failure is not
        # retried on every call — one attempt per TTL.
        os.environ['T_BOARDS_URL'] = 'http://127.0.0.1:9'  # nothing listens there
        self.age_cache(10 * ps.TTL_SECONDS)
        settings, source = ps.load(self.root)
        self.assertFalse(settings['toggles']['councilReview'])
        self.assertIn('last read failed', source)
        start = time.time()
        for _ in range(5):
            ps.enabled('councilReview', self.root)
        self.assertLess(time.time() - start, 0.5)

    def test_incomplete_or_refused_answers_keep_the_last_known(self):
        self.connect()
        self.assertFalse(ps.enabled('councilReview', self.root))
        for body in ({}, {'automation': True}, {'automation': True, 'toggles': {'swarm': False}}):
            Board.body = body
            self.age_cache(10 * ps.TTL_SECONDS)
            settings, _ = ps.load(self.root)
            self.assertFalse(settings['toggles']['councilReview'], body)  # a stray {} never resets an «off»

    def test_a_board_from_before_a_late_switch_is_still_read(self):
        # The deployed board does not know evolveAutoMerge yet: its answer is whole without it, the switch is on.
        old_board = dict(FULL, toggles={n: v for n, v in FULL['toggles'].items() if n not in ps.LATE_TOGGLES})
        self.connect(dict(old_board, toggles=dict(old_board['toggles'], councilReview=False)))
        self.assertFalse(ps.enabled('councilReview', self.root))
        self.assertTrue(ps.enabled('evolveAutoMerge', self.root))
        self.assertFalse(ps.enabled('abJudgeClaude', self.root))  # the owner's tokens: off until the board says on
        # A late switch that is sent is the board's: off stays off; a non-boolean is an incomplete answer.
        self.assertIsNone(ps.complete(dict(FULL, toggles=dict(FULL['toggles'], evolveAutoMerge='no'))))
        self.assertFalse(ps.complete(dict(FULL, toggles=dict(FULL['toggles'], evolveAutoMerge=False)))
                         ['toggles']['evolveAutoMerge'])
        self.assertIsNone(ps.complete(dict(FULL, toggles={'evolveAutoMerge': True})))  # only late ones may be missing

    def test_redirect_and_plain_http_are_refused(self):
        self.connect()
        Board.redirect = 'http://127.0.0.1:9/steal'
        settings, error = ps.fetch(self.root)
        self.assertIsNone(settings)
        self.assertIn('HTTP 302', error)
        os.environ['T_BOARDS_URL'] = 'http://boards.example.org'
        self.assertIn('https', ps.fetch(self.root)[1])

    def test_repo_config_cannot_send_the_key_elsewhere(self):
        os.makedirs(os.path.join(self.root, 'eval', 'nerve'))
        with open(os.path.join(self.root, 'eval', 'nerve', 'config.json'), 'w', encoding='utf-8') as f:
            json.dump({'boards': {'url': 'https://evil.example.org', 'workspace': 'ws'}}, f)
        os.environ['T_BOARDS_PIPELINE_KEY'] = 'k-1'
        settings, error = ps.fetch(self.root)
        self.assertIsNone(settings)
        self.assertIn('not trusted', error)
        os.environ['T_BOARDS_ALLOWED_HOSTS'] = 'evil.example.org'  # only the person's own environment widens it
        self.assertNotIn('not trusted', ps.fetch(self.root, timeout=0.2)[1] or '')

    def test_product_is_found_without_an_id(self):
        self.connect()
        del os.environ['T_BOARDS_WORKSPACE']
        Board.workspaces = [{'id': 'ws-a', 'name': 'HR Helper', 'slug': 'hr'}]
        self.assertFalse(ps.enabled('councilReview', self.root))  # the one product the key reaches
        self.assertIn(('/api/pipeline-settings/workspace/ws-a', 'k-1'), Board.seen)

    def test_a_key_for_several_products_is_refused(self):
        # A key per product (d-tb-product-key-0411): naming one of the key's products does not make it usable.
        self.connect()
        del os.environ['T_BOARDS_WORKSPACE']
        Board.workspaces = [{'id': 'ws-a', 'name': 'HR Helper', 'slug': 'hr'},
                            {'id': 'ws-b', 'name': 'tAIBE', 'slug': 'taibe'}]
        for product in ('', 'TAIBE', 'ws-b'):
            os.environ['T_BOARDS_PRODUCT'] = product
            settings, error = ps.fetch(self.root)
            self.assertIsNone(settings, product)
            self.assertIn('several products (HR Helper, tAIBE)', error)
            self.assertIn('limited to one product', error)
        self.assertEqual([p for p, _ in Board.seen], ['/api/workspace'] * 3)  # no settings read with such a key

    def test_the_config_only_checks_the_keys_product(self):
        self.connect()
        os.environ['T_BOARDS_PRODUCT'] = 'TAIBE'  # by name or slug, case does not matter
        self.assertIsNotNone(ps.fetch(self.root)[0])
        os.environ['T_BOARDS_PRODUCT'] = 'HR Helper'
        self.assertIn("the key is for 'tAIBE', the config names 'HR Helper'", ps.fetch(self.root)[1])
        del os.environ['T_BOARDS_PRODUCT']
        os.environ['T_BOARDS_WORKSPACE'] = 'ws-other'
        self.assertIn("not for the workspace 'ws-other'", ps.fetch(self.root)[1])

    @unittest.skipUnless(os.path.isfile(SHIPPED), 'no instance config in this tree')
    def test_the_shipped_config_refuses_a_key_for_another_product(self):
        # Without boards.product nothing is checked, and a key put into the wrong install would turn on another
        # product's switches (lens of role 4 on f26a895e). The shipped config names its product.
        with open(SHIPPED, encoding='utf-8') as f:
            boards = json.load(f)['boards']
        product = str(boards.get('product') or '').strip()
        self.assertTrue(product, 'eval/nerve/config.json: boards.product is not set')
        os.makedirs(os.path.join(self.root, 'eval', 'nerve'))
        shutil.copy(SHIPPED, os.path.join(self.root, 'eval', 'nerve', 'config.json'))
        self.connect()
        del os.environ['T_BOARDS_WORKSPACE']  # the config's own workspace (if any) is the check
        own = str(boards.get('workspace') or '').strip() or 'ws-own'
        Board.workspaces = [{'id': own, 'name': product, 'slug': 'own'}]
        self.assertFalse(ps.enabled('councilReview', self.root))  # the owner's «off» on this product
        Board.workspaces = [{'id': 'ws-other', 'name': 'Another product', 'slug': 'another'}]
        Board.body = FULL
        self.age_cache(10 * ps.TTL_SECONDS)
        settings, source = ps.load(self.root)
        self.assertFalse(settings['toggles']['councilReview'])  # the other product's «on» does not leak in
        self.assertIn("the key is for 'Another product'", source)

    def test_the_boards_mcp_key_is_never_used(self):
        self.connect()
        del os.environ['T_BOARDS_PIPELINE_KEY']
        os.environ['T_BOARDS_API_KEY'] = 'k-mcp'
        settings, error = ps.fetch(self.root)
        self.assertIsNone(settings)
        self.assertIn('no T_BOARDS_PIPELINE_KEY', error)
        self.assertEqual(Board.seen, [])

    def test_the_keychain_entry_is_this_installs_own(self):
        self.connect()
        del os.environ['T_BOARDS_PIPELINE_KEY']
        os.environ['T_BOARDS_API_KEY'] = 'k-mcp'
        tools = os.path.join(self.root, 'infra', 'scripts', 'dev-ai')
        os.makedirs(tools)
        with open(os.path.join(tools, 'mcp-secret.sh'), 'w', encoding='utf-8') as f:
            f.write('printf "%s\\n" "$1" >> "$(dirname "$0")/asked"\n'
                    '[ "$1" = T_BOARDS_PIPELINE_KEY ] && { echo k-chain; exit 0; }\nexit 1\n')
        self.assertIsNotNone(ps.fetch(self.root)[0])
        with open(os.path.join(tools, 'asked'), encoding='utf-8') as f:
            self.assertEqual(f.read().split(), ['T_BOARDS_PIPELINE_KEY'])
        self.assertEqual({k for _, k in Board.seen}, {'k-chain'})

    def test_a_missing_key_is_looked_up_once_per_ttl(self):
        self.connect()
        del os.environ['T_BOARDS_PIPELINE_KEY']
        tools = os.path.join(self.root, 'infra', 'scripts', 'dev-ai')
        os.makedirs(tools)
        with open(os.path.join(tools, 'mcp-secret.sh'), 'w', encoding='utf-8') as f:
            f.write('printf "%s\\n" "$1" >> "$(dirname "$0")/asked"\nexit 1\n')
        for _ in range(5):
            self.assertTrue(ps.enabled('swarm', self.root))  # no key yet → defaults
        with open(os.path.join(tools, 'asked'), encoding='utf-8') as f:
            self.assertEqual(len(f.read().split()), 1)  # one Keychain call, not one per prompt
        self.assertIn('no T_BOARDS_PIPELINE_KEY', ps.load(self.root, refresh=False)[1])
        self.assertEqual(Board.seen, [])

    def test_a_url_the_key_is_never_sent_to_does_not_ask_keychain(self):
        self.connect()
        del os.environ['T_BOARDS_PIPELINE_KEY']
        os.environ['T_BOARDS_URL'] = 'http://boards.example.org'  # plain http, not localhost
        tools = os.path.join(self.root, 'infra', 'scripts', 'dev-ai')
        os.makedirs(tools)
        with open(os.path.join(tools, 'mcp-secret.sh'), 'w', encoding='utf-8') as f:
            f.write('printf "%s\\n" "$1" >> "$(dirname "$0")/asked"\necho k-1\n')
        for _ in range(5):
            self.assertTrue(ps.enabled('swarm', self.root))  # bad URL → defaults
        self.assertFalse(os.path.exists(os.path.join(tools, 'asked')))  # the key is not read for a refused URL
        self.assertIn('https', ps.fetch(self.root)[1])
        self.assertEqual(Board.seen, [])

    def test_unresolved_product_is_asked_once_per_ttl(self):
        self.connect()
        del os.environ['T_BOARDS_WORKSPACE']
        Board.workspaces = [{'id': 'ws-a', 'name': 'HR Helper', 'slug': 'hr'},
                            {'id': 'ws-b', 'name': 'tAIBE', 'slug': 'taibe'}]
        for _ in range(5):
            self.assertTrue(ps.enabled('councilReview', self.root))  # no single product → defaults
        self.assertEqual(len(Board.seen), 1)  # the failure is remembered, not retried by every hook
        self.assertIn('several products', ps.load(self.root, refresh=False)[1])

    def test_the_key_is_asked_on_every_refresh(self):
        self.connect()
        del os.environ['T_BOARDS_WORKSPACE']
        Board.workspaces = [{'id': 'ws-a', 'name': 'HR Helper', 'slug': 'hr'}]
        self.assertFalse(ps.enabled('councilReview', self.root))
        Board.seen = []
        self.assertIsNotNone(ps.fetch(self.root)[0])
        self.assertEqual([p for p, _ in Board.seen], ['/api/workspace', '/api/pipeline-settings/workspace/ws-a'])
        # The key is swapped for one that reaches several products: refused on the next refresh, and the owner's
        # «off» of the product read before stays off.
        Board.workspaces.append({'id': 'ws-b', 'name': 'tAIBE', 'slug': 'taibe'})
        self.age_cache(10 * ps.TTL_SECONDS)
        settings, source = ps.load(self.root)
        self.assertFalse(settings['toggles']['councilReview'])
        self.assertIn('several products', source)
        # An install that names no product (this root has no config) reads whatever one product the key reaches:
        # its switches, not the cached ones. The shipped config names its product — see the shipped-config test.
        Board.workspaces = [{'id': 'ws-c', 'name': 'HR Helper', 'slug': 'hr'}]
        Board.body = FULL
        self.assertIsNotNone(ps.fetch(self.root)[0])
        self.assertTrue(ps.enabled('councilReview', self.root))

    def test_cache_of_another_workspace_is_ignored(self):
        self.connect()
        self.assertFalse(ps.enabled('councilReview', self.root))
        os.environ['T_BOARDS_WORKSPACE'] = 'other'
        os.environ['T_BOARDS_URL'] = 'http://127.0.0.1:9'
        self.assertTrue(ps.enabled('councilReview', self.root))  # not this product's switches → defaults
        with open(os.path.join(self.root, ps.CACHE), encoding='utf-8') as f:
            attempt = json.load(f)['lastAttempt']
        for _ in range(3):
            self.assertTrue(ps.enabled('councilReview', self.root))
        with open(os.path.join(self.root, ps.CACHE), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['lastAttempt'], attempt)  # one attempt per TTL, not one per hook

    def test_not_connected_is_said(self):
        settings, error = ps.fetch(self.root)
        self.assertIsNone(settings)
        self.assertIn('not connected', error)

    def test_broken_cache_is_defaults_not_a_crash(self):
        with open(os.path.join(self.root, ps.CACHE), 'w', encoding='utf-8') as f:
            f.write('{not json')
        self.assertTrue(ps.enabled('swarm', self.root))
        self.assertEqual(ps.load(self.root)[1], 'defaults (no board settings known)')

    def test_master_switch(self):
        with open(os.path.join(self.root, ps.CACHE), 'w', encoding='utf-8') as f:
            json.dump({'fetchedAt': time.time(), 'settings': dict(FULL, automation=False)}, f)
        self.assertFalse(ps.enabled('cardAutofill', self.root))


def _paths(cafile=None, capath=None):
    return ssl.DefaultVerifyPaths(cafile, capath, 'SSL_CERT_FILE', '/nowhere/cert.pem', 'SSL_CERT_DIR', '/nowhere/certs')


class TlsContextTest(unittest.TestCase):
    """ОШИБКИ #634: python.org's macOS Python without a CA store must verify against the system bundle."""

    def test_own_store_keeps_the_default(self):
        for paths in (_paths(cafile='/x/cert.pem'), _paths(capath='/x/certs')):
            with mock.patch.object(ps.ssl, 'get_default_verify_paths', return_value=paths):
                self.assertIsNone(ps._tls_context(), paths)

    def test_no_store_takes_the_first_system_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            bundle = os.path.join(d, 'cert.pem')
            open(bundle, 'w').close()
            with mock.patch.object(ps.ssl, 'get_default_verify_paths', return_value=_paths()), \
                    mock.patch.object(ps, 'SYSTEM_CA_FILES', (os.path.join(d, 'missing.pem'), bundle)), \
                    mock.patch.object(ps.ssl, 'create_default_context', return_value='ctx') as create:
                self.assertEqual(ps._tls_context(), 'ctx')
            create.assert_called_once_with(cafile=bundle)

    def test_no_store_and_no_bundle_keeps_the_default(self):
        with mock.patch.object(ps.ssl, 'get_default_verify_paths', return_value=_paths()), \
                mock.patch.object(ps, 'SYSTEM_CA_FILES', ('/nowhere/a.pem', '/nowhere/b.pem')):
            self.assertIsNone(ps._tls_context())

    @unittest.skipUnless(any(os.path.isfile(f) for f in ps.SYSTEM_CA_FILES), 'no system CA bundle here')
    def test_fallback_still_verifies(self):
        with mock.patch.object(ps.ssl, 'get_default_verify_paths', return_value=_paths()):
            ctx = ps._tls_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertGreater(ctx.cert_store_stats()['x509_ca'], 0)

    def test_fetch_uses_the_context(self):
        real, seen = ps.urllib.request.build_opener, []

        def build_opener(*handlers):
            seen.extend(h for h in handlers if isinstance(h, ps.urllib.request.HTTPSHandler))
            return real(*handlers)
        ctx = ssl.create_default_context()
        with mock.patch.object(ps, '_tls_context', return_value=ctx), \
                mock.patch.object(ps.urllib.request, 'build_opener', side_effect=build_opener), \
                mock.patch.dict(os.environ, {'T_BOARDS_URL': 'http://127.0.0.1:9', 'T_BOARDS_PIPELINE_KEY': 'k-1',
                                             'T_BOARDS_WORKSPACE': 'ws 1'}), \
                tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, '.claude'))
            ps.fetch(root, timeout=0.2)
        self.assertEqual([h._context for h in seen], [ctx])


if __name__ == '__main__':
    unittest.main()

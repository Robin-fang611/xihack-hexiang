"""双端口（消费者端 + OPC 创作者端）隔离数据的真实 HTTP 验收。

覆盖：创作者注册入驻、作品发布/撤下权限、公开投影白名单（用户原话不泄露）、
bootstrap.works 形状与一键入案兼容性、商品发布回归与新静态资源。不触碰正式 .local/ 数据。
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import http.cookiejar
from pathlib import Path

import server


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None
        self.call('GET', '/api/session')

    def call(self, method, path, data=None, origin=None, csrf=True):
        headers = {'Origin': origin or self.base}
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        if self.csrf and csrf:
            headers['X-CSRF-Token'] = self.csrf
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=35)
        except urllib.error.HTTPError as exc:
            response = exc
        raw = response.read()
        value = json.loads(raw) if response.headers.get_content_type() == 'application/json' else raw
        if isinstance(value, dict) and value.get('csrf_token'):
            self.csrf = value['csrf_token']
        return response.code, value


class DualPortalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='xihack-portal-qa-')
        cls.store = server.Store(Path(cls.tmp.name))
        cls.http = server.AppServer(('127.0.0.1', 0), cls.store)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'
        cls.creator = Client(cls.base)
        cls.creator_a = Client(cls.base)
        cls.user = Client(cls.base)
        cls.guest = Client(cls.base)
        assert cls.creator.call('POST', '/api/register', {'username': 'qa_creator_a', 'password': 'Testing-Creator-123', 'account_kind': 'creator', 'display_name': '验收香铺'})[0] == 200
        assert cls.creator_a.call('POST', '/api/register', {'username': 'qa_creator_b', 'password': 'Testing-Creator-123', 'account_kind': 'creator'})[0] == 200
        assert cls.user.call('POST', '/api/register', {'username': 'qa_user_plain', 'password': 'Testing-User-123'})[0] == 200

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def save_design(self, client, *, name=None, notes='这条原话绝不能公开', profile_id='F01', preferred=('woody',)):
        self._design_counter = getattr(self, '_design_counter', 0) + 1
        name = name or f'验收作品{self._design_counter:02d}'
        payload = {
            'components': [{'profile_id': profile_id, 'role': 'main'}],
            'name': name, 'scenario': '深夜书房', 'user_notes': notes,
            'raw_preferences': ['原话偏好'], 'preferred_facets': list(preferred),
            'deemphasized_facets': [], 'excluded_ids': [],
        }
        code, data = client.call('POST', '/api/designs', payload)
        self.assertIn(code, (200, 201))
        return data['design']['id']

    def test_01_registration_kinds(self):
        anonymous = Client(self.base)
        self.assertEqual(anonymous.call('POST', '/api/register', {'username': 'fake_manager', 'password': 'Testing-123', 'role': 'manager'})[0], 403)
        self.assertEqual(anonymous.call('POST', '/api/register', {'username': 'bad_kind', 'password': 'Testing-123', 'account_kind': 'admin'})[0], 400)
        code, data = self.creator.call('GET', '/api/session')
        self.assertEqual((code, data['user']['role']), (200, 'manager'))
        code, data = self.user.call('GET', '/api/session')
        self.assertEqual(data['user']['role'], 'user')

    def test_02_new_static_resources(self):
        for path in ('/static/modules/creator.js', '/static/styles/hall.css', '/static/styles/creator.css'):
            self.assertEqual(self.guest.call('GET', path)[0], 200)
        code, data = self.guest.call('GET', '/api/bootstrap')
        self.assertEqual(code, 200)
        self.assertEqual(data['works'], [])

    def test_03_publish_permissions(self):
        design_id = self.save_design(self.creator)
        self.assertEqual(self.guest.call('POST', f'/api/designs/{design_id}/publish', {'public_note': 'x'})[0], 401)
        self.assertEqual(self.user.call('POST', f'/api/designs/{design_id}/publish', {'public_note': 'x'})[0], 404)
        self.assertEqual(self.creator_a.call('POST', f'/api/designs/{design_id}/publish', {'public_note': 'x'})[0], 404)
        self.assertEqual(self.creator.call('POST', f'/api/designs/{"0" * 32}/publish', {'public_note': 'x'})[0], 404)
        self.assertEqual(self.creator.call('POST', f'/api/designs/{design_id}/publish', {'public_note': ['不是文字']})[0], 400)
        self.assertTrue(design_id)

    def test_04_public_projection_whitelist(self):
        design_id = self.save_design(self.creator)
        code, data = self.creator.call('POST', f'/api/designs/{design_id}/publish', {'public_note': '为深夜书房设计的木质香（验收）'})
        self.assertEqual(code, 200)
        self.assertTrue(data['design']['published'])
        code, boot = self.creator.call('GET', '/api/bootstrap')
        works = [item for item in boot['works'] if item['id'] == design_id]
        self.assertEqual(len(works), 1)
        work = works[0]
        self.assertEqual(work['kind'], 'creator_work')
        self.assertTrue(work['name'].startswith('验收作品'))
        self.assertEqual(work['creator_name'], '验收香铺')
        self.assertEqual(work['public_note'], '为深夜书房设计的木质香（验收）')
        raw = json.dumps(work, ensure_ascii=False)
        for forbidden in ('user_notes', 'raw_preferences', 'raw_exclusions', '原话绝不能公开', '原话偏好', 'owner_id'):
            self.assertNotIn(forbidden, raw, f'公开投影泄露了 {forbidden}')
        component = work['components'][0]
        for key in ('profile_id', 'role', 'name', 'form', 'source_id', 'source_url', 'source_locator'):
            self.assertIn(key, component)
        for key in ('preferred_facets', 'deemphasized_facets', 'excluded_ids', 'families', 'main_family', 'status', 'stamp'):
            self.assertIn(key, work)
        self.assertNotIn('description', work)

    def test_05_unpublish_and_republish(self):
        design_id = self.save_design(self.creator, name='撤下验收')
        self.creator.call('POST', f'/api/designs/{design_id}/publish', {'public_note': ''})
        _, boot = self.creator.call('GET', '/api/bootstrap')
        self.assertIn(design_id, [item['id'] for item in boot['works']])
        self.creator.call('POST', f'/api/designs/{design_id}/unpublish', {})
        _, boot = self.creator.call('GET', '/api/bootstrap')
        self.assertNotIn(design_id, [item['id'] for item in boot['works']])
        code, data = self.creator.call('POST', f'/api/designs/{design_id}/publish', {})
        self.assertEqual(code, 200)
        self.assertTrue(data['design']['published'])

    def test_06_creator_product_publish_regression(self):
        fields = {'name': '验收商品（测试）', 'brand': '验收香铺', 'form': 'incense',
                  'description': '测试商品的木质描述；非真实在售产品。',
                  'notes': '木质、甜香', 'ingredients': '示例声明：檀香粉'}
        code, data = self.creator.call('POST', '/api/products', fields)
        self.assertEqual(code, 201)
        product_id = data['product']['id']
        self.assertEqual(data['product']['kind'], 'catalog')
        publish = {'purchase_url': 'https://example.com/qa-portal-product', 'price': '¥1（验收）',
                   'public_fields': ['description', 'notes', 'ingredients', 'price']}
        self.assertEqual(self.user.call('POST', f'/api/products/{product_id}/publish', publish)[0], 403)
        code, data = self.creator.call('POST', f'/api/products/{product_id}/publish', publish)
        self.assertEqual(code, 200)
        _, boot = self.guest.call('GET', '/api/bootstrap')
        product = next(item for item in boot['products'] if item['id'] == product_id)
        self.assertEqual(product['purchase_url'], 'https://example.com/qa-portal-product')
        self.assertEqual(product['seller_name'], '验收香铺')
        self.assertIn('ingredients', product)
        self.assertNotIn('image_url', product)
        self.assertNotIn('personal_notes', product)

    def test_07_match_uses_public_products(self):
        _, boot = self.guest.call('GET', '/api/bootstrap')
        work = boot['works'][0]
        design = {'components': work['components'], 'families': work['families'], 'excluded_ids': work['excluded_ids']}
        code, data = self.guest.call('POST', '/api/match', {'design': design})
        self.assertEqual(code, 200)
        self.assertIn(data['status'], ('ok', 'no_supported_preferences'))

    def test_08_designs_listing_carries_publish_state(self):
        code, data = self.creator.call('GET', '/api/designs')
        self.assertEqual(code, 200)
        self.assertTrue(data['designs'])
        republished = [d for d in data['designs'] if d['name'] == '撤下验收']
        self.assertTrue(republished and republished[0]['published'] is True)
        for design in data['designs']:
            self.assertFalse(design.get('published', False) not in (True, False))


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DualPortalTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)

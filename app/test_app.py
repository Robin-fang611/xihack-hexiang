"""隔离数据的真实HTTP验收；不使用或更改运行中的用户资料。"""
import base64
import io
import json
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import http.cookiejar
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
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


def picture():
    image = Image.new('RGB', (1400, 700), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 54)
    for index, text in enumerate(['TEST FRAGRANCE', 'Notes: WOODY, SWEET', 'Ingredients: PARFUM, WATER']):
        draw.text((50, 70 + index * 160), text, fill='black', font=font)
    exif = Image.Exif()
    exif[270] = 'PRIVATE_IMAGE_METADATA'
    output = io.BytesIO()
    image.save(output, 'JPEG', exif=exif)
    return output.getvalue()


class AppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='xihack-app-qa-')
        cls.store = server.Store(Path(cls.tmp.name))
        native = server.ROOT / '.local' / 'ocr'
        if native.exists():
            shutil.copyfile(native, cls.store.ocr)
            cls.store.ocr.chmod(0o700)
        cls.http = server.AppServer(('127.0.0.1', 0), cls.store)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'
        cls.manager = Client(cls.base)
        account = (cls.store.path / '本机管理者账号.txt').read_text()
        password = account.split('密码：')[1].strip()
        assert cls.manager.call('POST', '/api/login', {'username': 'manager', 'password': password})[0] == 200
        cls.a, cls.b = Client(cls.base), Client(cls.base)
        assert cls.a.call('POST', '/api/register', {'username': 'qa_user_a', 'password': 'Testing-User-A-123'})[0] == 200
        assert cls.b.call('POST', '/api/register', {'username': 'qa_user_b', 'password': 'Testing-User-B-123'})[0] == 200

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def test_01_bootstrap_and_static(self):
        code, data = self.a.call('GET', '/api/bootstrap')
        self.assertEqual(code, 200)
        self.assertEqual(len(data['profiles']), 5)
        self.assertEqual(len(data['presets']), 3)
        self.assertEqual(len(data['vocabulary']), 10)
        self.assertEqual(self.a.call('GET', '/static/style.css')[0], 200)
        self.assertEqual(self.a.call('GET', '/server.py')[0], 404)
        self.assertEqual(self.a.call('GET', '/.local/app.sqlite3')[0], 404)

    def test_02_registration_and_private_kind(self):
        anonymous = Client(self.base)
        self.assertEqual(anonymous.call('POST', '/api/register', {'username': 'fake_manager', 'password': 'Testing-123', 'role': 'manager'})[0], 403)
        self.assertEqual(self.a.call('POST', '/api/products', {'name': '测试', 'kind': 'catalog'})[0], 403)
        self.assertEqual(self.a.call('GET', '/api/session')[1]['user']['role'], 'user')

    def test_03_private_upload_and_object_permissions(self):
        file = base64.b64encode('香调: 木质、甜香\n成分: 香精、水\nPRIVATE_ATTACHMENT_SECRET'.encode()).decode()
        code, result = self.a.call('POST', '/api/products', {'name': '仅测试私人香品', 'notes': '木质',
             'personal_notes': 'PRIVATE_PERSONAL_SECRET', 'file': {'name': '资料.txt', 'data': file, 'type': 'text/plain'},
             'owner_id': 'ignored', 'published': True, 'role': 'manager'})
        self.assertEqual(code, 201)
        product = result['product']
        self.assertEqual(product['kind'], 'private')
        self.assertFalse(product['published'])
        self.assertIn('woody', product['analysis']['families'])
        self.assertEqual(self.a.call('GET', product['asset_url'])[0], 200)
        self.assertEqual(self.b.call('GET', product['asset_url'])[0], 404)
        self.assertEqual(self.b.call('PATCH', f"/api/products/{product['id']}", {'name': '盗改'})[0], 404)
        self.assertEqual(self.a.call('POST', f"/api/products/{product['id']}/publish", {})[0], 403)
        other = self.b.call('GET', '/api/products')[1]['products']
        self.assertNotIn(product['id'], [p['id'] for p in other])
        homepage = self.a.call('GET', '/api/bootstrap')[1]['products']
        self.assertNotIn(product['id'], [p['id'] for p in homepage])

    def test_04_manager_public_projection_image_and_unpublish(self):
        body = picture()
        code, result = self.manager.call('POST', '/api/products', {
            'name': '测试商品非真实在售', 'brand': '测试管理者', 'form': 'perfume',
            'notes': '木质、甜香', 'description': 'PRIVATE_DESCRIPTION_SECRET',
            'ingredients': 'PRIVATE_INGREDIENT_SECRET', 'personal_notes': 'PRIVATE_PERSONAL_SECRET',
            'file': {'name': '标签.jpg', 'type': 'image/jpeg', 'data': base64.b64encode(body).decode()}})
        self.assertEqual(code, 201)
        product = result['product']
        self.assertEqual(product['kind'], 'catalog')
        if self.store.ocr.exists():
            self.assertEqual(product['ocr_status'], 'recognized')
            self.assertIn('WOODY', product['extracted_text'].upper())
        self.assertEqual(self.a.call('GET', product['asset_url'])[0], 404)
        publish = f"/api/products/{product['id']}/publish"
        self.assertEqual(self.manager.call('POST', publish, {'purchase_url': 'javascript:alert(1)', 'public_fields': ['notes']})[0], 400)
        self.assertEqual(self.manager.call('POST', publish, {'purchase_url': 'http://127.0.0.1:1234', 'public_fields': ['notes']})[0], 400)
        self.assertEqual(self.manager.call('POST', publish, {'purchase_url': 'https://example.com/test-product', 'public_fields': ['notes', 'image']})[0], 200)
        anonymous = Client(self.base)
        home = anonymous.call('GET', '/api/bootstrap')[1]['products']
        public = next(p for p in home if p['id'] == product['id'])
        serialized = json.dumps(public)
        self.assertNotIn('PRIVATE_', serialized)
        self.assertNotIn('extracted_text', public)
        self.assertNotIn('personal_notes', public)
        self.assertNotIn('owner_id', public)
        code, public_image = anonymous.call('GET', public['image_url'])
        self.assertEqual(code, 200)
        self.assertEqual(len(Image.open(io.BytesIO(public_image)).getexif()), 0)
        self.assertEqual(self.manager.call('POST', f"/api/products/{product['id']}/unpublish", {})[0], 200)
        self.assertEqual(anonymous.call('GET', public['image_url'])[0], 404)
        self.assertEqual(self.manager.call('GET', product['asset_url'])[0], 200)

    def test_05_csrf_and_origin(self):
        self.assertEqual(self.a.call('POST', '/api/products', {'name': '未授权'}, csrf=False)[0], 403)
        self.assertEqual(self.a.call('POST', '/api/products', {'name': '未授权'}, origin='https://evil.invalid')[0], 403)

    def test_06_design_aliases_and_private_save(self):
        code, result = self.a.call('POST', '/api/compose', {'preferred_facets': ['木质'], 'deemphasized_facets': ['甜香'], 'locked_main_id': 'F01'})
        self.assertEqual(code, 200)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(len(result['candidates']), 2)
        self.assertTrue(all(c['components'][0]['profile_id'] == 'F01' for c in result['candidates']))
        unsupported = self.a.call('POST', '/api/compose', {'preferred_facets': ['花香']})[1]
        self.assertEqual(unsupported['status'], 'no_supported_preferences')
        payload = {'name': 'QA香笺', 'scenario': '测试阅读角', 'components': [{'profile_id': 'F02', 'role': 'main'}, {'profile_id': 'F04', 'role': 'accent'}],
                   'manufacturing_approved': True, 'sensory_verified': True}
        saved = self.a.call('POST', '/api/designs', payload)[1]['design']
        self.assertFalse(saved['manufacturing_approved'])
        self.assertFalse(saved['sensory_verified'])
        self.assertNotIn(saved['id'], [d['id'] for d in self.b.call('GET', '/api/designs')[1]['designs']])

    def test_07_simulation_owner_and_rejection(self):
        board = {'components': [{'profile_id': 'F01', 'role': 'main'}]}
        accepted = self.a.call('POST', '/api/simulation', {'action': 'handoff', 'space_id': 'reading', 'design': board})[1]
        self.assertEqual(accepted['status'], 'accepted')
        sid = accepted['simulation']['id']
        self.assertEqual(self.b.call('POST', '/api/simulation', {'action': 'start', 'simulation_id': sid})[0], 404)
        running = self.a.call('POST', '/api/simulation', {'action': 'start', 'simulation_id': sid})[1]
        self.assertTrue(running['simulation']['running'])
        timed = self.a.call('POST', '/api/simulation', {'action': 'set_timer', 'simulation_id': sid, 'timer_minutes': 12})[1]
        self.assertEqual(timed['simulation']['timer_minutes'], 12)
        self.assertEqual(self.a.call('POST', '/api/simulation', {'action': 'set_timer', 'simulation_id': sid, 'timer_minutes': 999})[0], 400)
        rejected = self.a.call('POST', '/api/simulation', {'action': 'handoff', 'space_id': 'reading', 'design': {'components': [{'profile_id': 'F05', 'role': 'main'}]}})[1]
        self.assertEqual(rejected['status'], 'rejected')

    def test_08_logout_revokes_session(self):
        disposable = Client(self.base)
        disposable.call('POST', '/api/register', {'username': 'qa_logout', 'password': 'Testing-Logout-123'})
        self.assertEqual(disposable.call('GET', '/api/products')[0], 200)
        self.assertEqual(disposable.call('POST', '/api/logout', {})[0], 200)
        self.assertEqual(disposable.call('GET', '/api/products')[0], 401)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(AppTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    evidence = {'tests': result.testsRun, 'passed': result.wasSuccessful(),
                'scope': '隔离临时数据库的真实HTTP会话、权限、资料提取、公开投影、设计保存和模拟接口；非商家业务验收',
                'failures': [str(error) for _, error in result.failures + result.errors]}
    output = server.ROOT / 'verification'
    output.mkdir(exist_ok=True)
    (output / '接口验收.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)

"""本机开发服务器。持久账号/会话、本人资料与公开投影；无外部付费模型调用。"""
import argparse
import base64
import hashlib
import hmac
import ipaddress
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
MAX_FILE = 8 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
FIELDS = ('name', 'brand', 'form', 'spec', 'description', 'notes', 'ingredients',
          'personal_notes', 'source_url')
PUBLIC_OPTIONAL = {'description', 'notes', 'ingredients', 'source_url', 'image', 'price'}
COOKIE = 'scent_session'
PIL_AVAILABLE = False
try:
    from PIL import Image, ImageOps
    PIL_AVAILABLE = True
except ImportError:
    pass


def now():
    return datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 260000).hex()
    return f'{salt}:{digest}'


def password_matches(password, stored):
    salt = stored.split(':')[0]
    return hmac.compare_digest(password_hash(password, salt), stored)


class Problem(Exception):
    def __init__(self, status, message, code='request_failed'):
        self.status, self.message, self.code = status, message, code


class Store:
    def __init__(self, path):
        self.path = path
        self.path.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path, 0o700)
        self.uploads = self.path / 'private_uploads'
        self.public = self.path / 'public_images'
        self.uploads.mkdir(exist_ok=True)
        self.public.mkdir(exist_ok=True)
        self.db_path = self.path / 'app.sqlite3'
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE,
                  display_name TEXT, role TEXT, password TEXT, created_at TEXT);
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT,
                  csrf TEXT, expires REAL);
                CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, owner_id TEXT,
                  data TEXT, created_at TEXT, updated_at TEXT);
                CREATE TABLE IF NOT EXISTS designs(id TEXT PRIMARY KEY, owner_id TEXT,
                  data TEXT, created_at TEXT);
            ''')
            if not db.execute("SELECT 1 FROM users WHERE role='manager'").fetchone():
                password = secrets.token_urlsafe(15)
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',
                           (uuid.uuid4().hex, 'manager', '本机管理者', 'manager', password_hash(password), now()))
                account = self.path / '本机管理者账号.txt'
                account.write_text(f'仅用于本机开发软件，未对外发布。\n账号：manager\n密码：{password}\n')
                os.chmod(account, 0o600)
        os.chmod(self.db_path, 0o600)
        self.ocr = self.path / 'ocr'

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def product(self, product_id):
        with self.db() as db:
            row = db.execute('SELECT * FROM products WHERE id=?', (product_id,)).fetchone()
        if not row:
            return None
        return {**json.loads(row['data']), 'id': row['id'], 'owner_id': row['owner_id'],
                'created_at': row['created_at'], 'updated_at': row['updated_at']}

    def save_product(self, product):
        data = {k: v for k, v in product.items() if k not in ('id', 'owner_id', 'created_at', 'updated_at')}
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO products VALUES(?,?,?,?,?)',
                       (product['id'], product['owner_id'], dumps(data), product['created_at'], now()))

    def all_products(self, owner=None):
        with self.db() as db:
            if owner:
                rows = db.execute('SELECT id FROM products WHERE owner_id=? ORDER BY created_at DESC', (owner,)).fetchall()
            else:
                rows = db.execute('SELECT id FROM products ORDER BY updated_at DESC').fetchall()
        return [self.product(row['id']) for row in rows]


def valid_url(value, commerce=False):
    value = str(value or '').strip()
    if not value:
        return ''
    parsed = urlparse(value)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
        raise Problem(400, '请填写完整的http或https商品链接。', 'invalid_url')
    if commerce:
        hostname = parsed.hostname.lower()
        if hostname == 'localhost' or hostname.endswith(('.localhost', '.local')) or '.' not in hostname:
            raise Problem(400, '购买入口需指向商家的公开商品页面。', 'invalid_shop_url')
        try:
            address = ipaddress.ip_address(hostname)
            if not address.is_global:
                raise Problem(400, '购买入口不能指向本机或内网。', 'invalid_shop_url')
        except ValueError:
            pass
    return value[:2000]


def text_fields(payload, old=None):
    result = dict(old or {})
    for field in FIELDS:
        if field in payload or old is None:
            value = payload.get(field, '')
            if not isinstance(value, str):
                raise Problem(400, '资料文字格式不正确。', 'invalid_text')
            result[field] = value.strip()[:20000 if field not in ('name', 'brand', 'form', 'spec') else 200]
    if not result.get('name'):
        result['name'] = '待确认香品'
    result['source_url'] = valid_url(result.get('source_url'))
    return result


def read_upload(store, file):
    if not file:
        return {}, ''
    if not isinstance(file, dict):
        raise Problem(400, '附件格式不正确。')
    name = Path(str(file.get('name', '资料'))).name[:180]
    raw = str(file.get('data', ''))
    if raw.startswith('data:'):
        raw = raw.split(',', 1)[-1]
    try:
        body = base64.b64decode(raw, validate=True)
    except Exception:
        raise Problem(400, '附件编码不正确。', 'invalid_file')
    if not body or len(body) > MAX_FILE:
        raise Problem(400, '请上传不超过8MB的资料。', 'file_too_large')
    ext = Path(name).suffix.lower()
    if ext not in ('.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.pdf', '.docx'):
        raise Problem(400, '支持照片、TXT、Markdown、PDF和Word资料。', 'unsupported_file')
    path = store.uploads / (uuid.uuid4().hex + ext)
    path.write_bytes(body)
    os.chmod(path, 0o600)
    info = {'file_name': name, 'file_path': path.name, 'file_type': mimetypes.guess_type(name)[0] or 'application/octet-stream',
            'file_is_image': False, 'ocr_status': 'not_needed'}
    text = ''
    try:
        if ext in ('.png', '.jpg', '.jpeg', '.webp'):
            if not PIL_AVAILABLE:
                raise ValueError('image_reader_unavailable')
            with Image.open(path) as image:
                if image.width * image.height > 30_000_000:
                    raise Problem(400, '图片尺寸过大，请缩小后上传。', 'image_too_large')
                if image.format not in ('PNG', 'JPEG', 'WEBP'):
                    raise Problem(400, '图片内容与支持的格式不符。', 'invalid_image')
                normalized = ImageOps.exif_transpose(image).convert('RGB')
                thumb = store.uploads / (uuid.uuid4().hex + '.jpg')
                normalized.thumbnail((1600, 1600))
                normalized.save(thumb, 'JPEG', quality=90)
                info['normalized_image_path'] = thumb.name
                info['file_is_image'] = True
            if store.ocr.exists():
                result = subprocess.run([str(store.ocr), str(thumb)], capture_output=True, text=True, timeout=25)
                if result.returncode == 0:
                    recognized = json.loads(result.stdout)
                    text = recognized.get('text', '')[:50000]
                    info['ocr_status'] = recognized.get('status', 'recognized')
                else:
                    info['ocr_status'] = 'failed'
            else:
                info['ocr_status'] = 'unavailable'
        elif ext in ('.txt', '.md'):
            text = body.decode('utf-8-sig', errors='replace')[:50000]
            info['ocr_status'] = 'text_read'
        elif ext == '.pdf':
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(body))
            text = '\n'.join(page.extract_text() or '' for page in list(reader.pages)[:5])[:50000]
            info['ocr_status'] = 'pdf_text_read' if text.strip() else 'pdf_no_text'
            info['extraction_note'] = '提取前5页可读取文字；扫描PDF请改传照片。'
        elif ext == '.docx':
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                meta = archive.getinfo('word/document.xml')
                if meta.file_size > 2_000_000:
                    raise Problem(400, 'Word正文过大，请截取相关资料。')
                xml = ElementTree.fromstring(archive.read(meta))
                text = '\n'.join(node.text or '' for node in xml.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))[:50000]
                info['ocr_status'] = 'document_text_read'
    except Problem:
        path.unlink(missing_ok=True)
        raise
    except Exception:
        info['ocr_status'] = 'failed'
    return info, text


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, store):
        super().__init__(address, Handler)
        self.store = store
        self.simulations = {}
        self.sim_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_bytes(self, status, body, content_type='application/json; charset=utf-8', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        if getattr(self, 'new_cookie', None):
            self.send_header('Set-Cookie', self.new_cookie)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def json(self, data, status=200):
        self.send_bytes(status, dumps(data).encode())

    def validate_origin(self):
        host = self.headers.get('Host', '')
        valid_hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if host not in valid_hosts:
            raise Problem(403, '请求来源不允许。', 'invalid_host')
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://{h}' for h in valid_hosts}:
            raise Problem(403, '请求来源不允许。', 'invalid_origin')

    def session(self):
        if hasattr(self, '_session'):
            return self._session
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except Exception:
            pass
        raw = cookies[COOKIE].value if COOKIE in cookies else ''
        digest = hashlib.sha256(raw.encode()).hexdigest() if raw else ''
        with self.server.store.db() as db:
            row = db.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (digest, time.time())).fetchone()
        if not row:
            raw = secrets.token_urlsafe(32)
            digest = hashlib.sha256(raw.encode()).hexdigest()
            csrf = secrets.token_urlsafe(24)
            with self.server.store.db() as db:
                db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest, None, csrf, time.time() + 86400 * 7))
            row = {'token': digest, 'user_id': None, 'csrf': csrf}
            self.new_cookie = f'{COOKIE}={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800'
        self._session = dict(row)
        return self._session

    def user(self, required=True):
        session = self.session()
        with self.server.store.db() as db:
            row = db.execute('SELECT id,username,display_name,role FROM users WHERE id=?', (session['user_id'],)).fetchone()
        if not row and required:
            raise Problem(401, '请先登录后管理自己的香品。', 'login_required')
        return dict(row) if row else None

    def csrf(self):
        token = self.headers.get('X-CSRF-Token', '')
        if not hmac.compare_digest(token, self.session()['csrf']):
            raise Problem(403, '操作校验已过期，请刷新后重试。', 'csrf_rejected')

    def login_user(self, user_id):
        old = self.session()['token']
        raw = secrets.token_urlsafe(32)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        csrf = secrets.token_urlsafe(24)
        with self.server.store.db() as db:
            db.execute('DELETE FROM sessions WHERE token=?', (old,))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest, user_id, csrf, time.time() + 86400 * 7))
        self._session = {'token': digest, 'user_id': user_id, 'csrf': csrf}
        self.new_cookie = f'{COOKIE}={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800'
        return {'user': self.user(), 'csrf_token': csrf}

    def own_product(self, product_id, manager=False):
        user = self.user()
        if manager and user['role'] != 'manager':
            raise Problem(403, '只有管理者可以操作首页推荐。', 'manager_required')
        product = self.server.store.product(product_id)
        if not product or product['owner_id'] != user['id']:
            raise Problem(404, '未找到可访问的香品。', 'product_not_found')
        if manager and product.get('kind') != 'catalog':
            raise Problem(403, '私人咨询档案不能发布到首页。', 'private_record')
        return product

    def product_view(self, product):
        result = {k: v for k, v in product.items() if k not in ('file_path', 'normalized_image_path', 'public_image_path', 'owner_id')}
        result['asset_url'] = f"/api/products/{product['id']}/asset" if product.get('file_path') else None
        return result

    def public_products(self):
        import services
        output = []
        for product in self.server.store.all_products():
            if not product.get('published') or product.get('kind') != 'catalog':
                continue
            selected = set(product.get('public_fields', [])) & PUBLIC_OPTIONAL
            public = {key: product.get(key, '') for key in ('id', 'name', 'brand', 'form', 'spec', 'purchase_url', 'updated_at')}
            for key in selected - {'image'}:
                public[key] = product.get(key, '')
            public_payload = {key: public.get(key, '') for key in FIELDS}
            public_payload['personal_notes'] = ''
            analyzed = services.analyze_product(public_payload)
            public['analysis'] = {key: analyzed.get(key, []) for key in ('families', 'reported_notes', 'system_inferences', 'gaps')}
            if 'image' in selected and product.get('public_image_path'):
                public['image_url'] = f"/api/public-assets/{product['id']}"
            public['seller_name'] = product.get('brand') or '管理者上传'
            output.append(public)
        return output

    def body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise Problem(413, '上传资料过大。', 'request_too_large')
        if self.headers.get_content_type() != 'application/json':
            raise Problem(400, '请求需要JSON格式。', 'invalid_content_type')
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            raise Problem(400, '请求内容无法读取。', 'invalid_json')
        if not isinstance(data, dict):
            raise Problem(400, '请求内容需要对象格式。', 'invalid_json')
        return data

    def do_GET(self):
        self.dispatch('GET')
    def do_POST(self):
        self.dispatch('POST')
    def do_PATCH(self):
        self.dispatch('PATCH')

    def dispatch(self, method):
        self.new_cookie = None
        try:
            self.validate_origin()
            path = unquote(urlparse(self.path).path)
            if path.startswith('/api/'):
                self.api(method, path)
                return
            if method != 'GET':
                raise Problem(405, '不支持该操作。')
            name = 'index.html' if path == '/' else path.lstrip('/')
            if name.startswith('static/'):
                name = name[len('static/'):]
            if name not in ('index.html', 'app.js', 'style.css'):
                raise Problem(404, '页面不存在。')
            static = ROOT / 'static' / name
            if not static.exists():
                raise Problem(503, '界面正在准备，请稍后刷新。')
            self.send_bytes(200, static.read_bytes(), mimetypes.guess_type(name)[0] or 'text/plain')
        except Problem as exc:
            self.json({'error': exc.message, 'code': exc.code}, exc.status)
        except (ValueError, TypeError, KeyError) as exc:
            self.json({'error': '输入信息格式不正确，请核对后重试。', 'code': 'invalid_input'}, 400)
        except Exception as exc:
            print(f'本机服务错误：{type(exc).__name__}', file=sys.stderr)
            self.json({'error': '处理未完成，资料仍可补充后重试。', 'code': 'processing_failed'}, 500)

    def api(self, method, path):
        import services
        store = self.server.store
        if method == 'GET' and path == '/api/session':
            self.json({'user': self.user(False), 'csrf_token': self.session()['csrf']})
            return
        if method == 'GET' and path == '/api/bootstrap':
            self.json({**services.bootstrap_data(), 'products': self.public_products(),
                       'app_name': '香笺', 'capabilities': {'ocr': store.ocr.exists(), 'documents': True},
                       'simulation_spaces': [{'id': 'reading', 'name': '阅读角', 'accepted_families': ['woody']},
                                             {'id': 'lobby', 'name': '民宿客厅', 'accepted_families': ['woody', 'balsamic']}]})
            return
        if method == 'GET' and path == '/api/products':
            user = self.user()
            self.json({'products': [self.product_view(p) for p in store.all_products(user['id'])]})
            return
        if method == 'GET' and path == '/api/designs':
            user = self.user()
            with store.db() as db:
                rows = db.execute('SELECT * FROM designs WHERE owner_id=? ORDER BY created_at DESC', (user['id'],)).fetchall()
            self.json({'designs': [{**json.loads(r['data']), 'id': r['id'], 'created_at': r['created_at']} for r in rows]})
            return
        asset = re.fullmatch(r'/api/products/([a-f0-9]{32})/asset', path)
        public_asset = re.fullmatch(r'/api/public-assets/([a-f0-9]{32})', path)
        if method == 'GET' and (asset or public_asset):
            if asset:
                product = self.own_product(asset.group(1))
                filename = product.get('file_path')
                folder = store.uploads
                content_type = product.get('file_type', 'application/octet-stream')
            else:
                product = store.product(public_asset.group(1))
                if not product or not product.get('published') or 'image' not in product.get('public_fields', []):
                    raise Problem(404, '图片不存在。')
                filename = product.get('public_image_path')
                folder = store.public
                content_type = 'image/jpeg'
            if not filename or not (folder / filename).exists():
                raise Problem(404, '附件不存在。')
            self.send_bytes(200, (folder / filename).read_bytes(), content_type)
            return
        payload = self.body() if method in ('POST', 'PATCH') else {}
        if method == 'POST' and path in ('/api/login', '/api/register'):
            username = str(payload.get('username', '')).strip()
            password = str(payload.get('password', ''))
            if not re.fullmatch(r'[\w.-]{3,32}', username) or not 8 <= len(password) <= 128:
                raise Problem(400, '账号需3至32个字母、数字或汉字，密码需8至128位。', 'invalid_account')
            with store.db() as db:
                row = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
                if path == '/api/register':
                    if payload.get('role', 'user') != 'user':
                        raise Problem(403, '普通注册不能取得管理者权限。', 'manager_registration_forbidden')
                    if row:
                        raise Problem(409, '这个账号已存在，请登录。', 'username_exists')
                    user_id = uuid.uuid4().hex
                    db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)', (user_id, username, str(payload.get('display_name') or username)[:40], 'user', password_hash(password), now()))
                else:
                    if not row or not password_matches(password, row['password']):
                        raise Problem(401, '账号或密码不正确。', 'login_failed')
                    user_id = row['id']
            self.json(self.login_user(user_id))
            return
        if method in ('POST', 'PATCH'):
            self.csrf()
        if method == 'POST' and path == '/api/logout':
            with store.db() as db:
                db.execute('DELETE FROM sessions WHERE token=?', (self.session()['token'],))
            self.new_cookie = f'{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
            self.json({'ok': True})
            return
        if method == 'POST' and path == '/api/products':
            user = self.user()
            kind = payload.get('kind', 'catalog' if user['role'] == 'manager' else 'private')
            if kind not in ('private', 'catalog'):
                raise Problem(400, '档案用途不正确。')
            if kind == 'catalog' and user['role'] != 'manager':
                raise Problem(403, '普通账号只能创建私人分析档案。', 'catalog_forbidden')
            fields = text_fields(payload)
            info, extracted = read_upload(store, payload.get('file'))
            product = {**fields, **info, 'id': uuid.uuid4().hex, 'owner_id': user['id'],
                       'kind': kind, 'created_at': now(), 'updated_at': now(), 'published': False,
                       'public_fields': [], 'purchase_url': '', 'price': '', 'extracted_text': extracted,
                       'analysis': services.analyze_product(fields, extracted)}
            store.save_product(product)
            self.json({'product': self.product_view(store.product(product['id']))}, 201)
            return
        match = re.fullmatch(r'/api/products/([a-f0-9]{32})(?:/(publish|unpublish))?', path)
        if match and method in ('POST', 'PATCH'):
            product_id, action = match.groups()
            product = self.own_product(product_id, manager=bool(action))
            if method == 'PATCH' and not action:
                product.update(text_fields(payload, product))
                product['analysis'] = services.analyze_product(product, product.get('extracted_text', ''))
            elif method == 'POST' and action == 'publish':
                selected = payload.get('public_fields', ['description', 'notes'])
                if not isinstance(selected, list) or set(selected) - PUBLIC_OPTIONAL:
                    raise Problem(400, '请选择支持公开的字段。', 'invalid_public_fields')
                product['purchase_url'] = valid_url(payload.get('purchase_url', product.get('purchase_url')), commerce=True)
                product['price'] = str(payload.get('price', product.get('price', '')))[:100]
                product['public_fields'] = selected
                if 'image' in selected and product.get('normalized_image_path'):
                    normalized = store.uploads / product['normalized_image_path']
                    public_name = product_id + '.jpg'
                    (store.public / public_name).write_bytes(normalized.read_bytes())
                    product['public_image_path'] = public_name
                product['published'] = True
            elif method == 'POST' and action == 'unpublish':
                product['published'] = False
            else:
                raise Problem(405, '不支持该操作。')
            store.save_product(product)
            self.json({'product': self.product_view(store.product(product_id))})
            return
        if method == 'POST' and path == '/api/compose':
            self.json(services.compose_design(payload))
            return
        if method == 'POST' and path == '/api/evaluate':
            self.json(services.evaluate_board(payload))
            return
        if method == 'POST' and path == '/api/designs':
            user = self.user()
            evaluated = services.evaluate_board(payload)
            if evaluated.get('status') != 'ok':
                self.json(evaluated, 400)
                return
            design = evaluated['design']
            design_id = uuid.uuid4().hex
            with store.db() as db:
                db.execute('INSERT INTO designs VALUES(?,?,?,?)', (design_id, user['id'], dumps(design), now()))
            self.json({'design': {**design, 'id': design_id}}, 201)
            return
        if method == 'POST' and path == '/api/match':
            self.json(services.match_products(payload.get('design', payload), self.public_products()))
            return
        if method == 'POST' and path == '/api/simulation':
            self.simulation(payload)
            return
        raise Problem(404, '接口不存在。')

    def simulation(self, payload):
        import services
        action = payload.get('action')
        scope = self.session()['token']
        with self.server.sim_lock:
            if action == 'handoff':
                evaluated = services.evaluate_board(payload.get('design', {}))
                if evaluated.get('status') != 'ok':
                    self.json({'status': 'rejected', 'reason': evaluated.get('reason', '方案需要先确认。')})
                    return
                design = evaluated['design']
                components = design.get('components', [])
                rules = services.bootstrap_data()
                profiles = {p['id']: p for p in rules['profiles']}
                main = next((p for p in components if p['role'] == 'main'), None)
                family = profiles[main['profile_id']]['primary_family'] if main else ''
                space = payload.get('space_id', 'reading')
                accepted = {'reading': {'woody'}, 'lobby': {'woody', 'balsamic'}}
                if space not in accepted or family not in accepted[space]:
                    self.json({'status': 'rejected', 'reason': '这个模拟空间暂不支持所选主调，可换空间或调整设计。'})
                    return
                simulation = {'id': uuid.uuid4().hex, 'space_id': space, 'running': False,
                              'timer_minutes': 10, 'remaining_minutes': 10,
                              'history': [{'action': 'handoff', 'at': now(), 'note': '软件模拟接收设计；不涉及真实耗材或设备。'}]}
                self.server.simulations[simulation['id']] = {'scope': scope, 'state': simulation}
                self.json({'status': 'accepted', 'reason': '模拟空间已接收，确认后可操作软件开关。', 'simulation': simulation})
                return
            entry = self.server.simulations.get(payload.get('simulation_id'))
            if not entry or entry['scope'] != scope:
                raise Problem(404, '未找到本会话的模拟。')
            state = entry['state']
            if action == 'start':
                state['running'] = True
            elif action == 'stop':
                state['running'] = False
            elif action == 'set_timer':
                minutes = int(payload.get('timer_minutes', 10))
                if not 1 <= minutes <= 120:
                    raise Problem(400, '模拟时长支持1至120分钟。')
                state['timer_minutes'] = minutes
                state['remaining_minutes'] = minutes
            else:
                raise Problem(400, '不支持的模拟动作。')
            state['history'].append({'action': action, 'at': now()})
            self.json({'status': 'accepted', 'simulation': state})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8870)
    parser.add_argument('--data-dir', type=Path, default=ROOT / '.local')
    args = parser.parse_args()
    store = Store(args.data_dir.resolve())
    if not store.ocr.exists() and sys.platform == 'darwin':
        try:
            compiled = subprocess.run(['/usr/bin/swiftc', str(ROOT / 'ocr.swift'), '-o', str(store.ocr)],
                                      capture_output=True, timeout=60)
            if compiled.returncode:
                print('本机OCR暂不可用，照片可以上传并补充文字资料。')
        except Exception:
            print('本机OCR暂不可用，照片可以上传并补充文字资料。')
    server = AppServer(('127.0.0.1', args.port), store)
    print(f'香笺本机软件：http://127.0.0.1:{args.port}', flush=True)
    print(f'管理者账号保存在：{store.path / "本机管理者账号.txt"}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

"""产品并发与公开副本验证；独立临时SQLite和真实HTTP，不触碰正式资料。"""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

import server
from test_app import Client, picture


class ProductConflictTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hexiang-product-cas-')
        self.store = server.Store(Path(self.temporary.name))
        self.http = server.AppServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.manager = Client(self.base)
        self.password = (self.store.path / '本机管理者账号.txt').read_text().split('密码：')[1].strip()
        self.assertEqual(self.manager.call('POST', '/api/login', {'username': 'manager', 'password': self.password})[0], 200)
        self.owner = self.manager.call('GET', '/api/session')[1]['user']['id']

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def create(self, *, image=False):
        payload = {'name': 'CAS测试商品', 'description': '公开描述木质', 'notes': '木质',
                   'personal_notes': 'PRIVATE_CAS_SECRET', 'kind': 'catalog'}
        if image:
            payload['file'] = {'name': '测试图.jpg', 'type': 'image/jpeg',
                               'data': base64.b64encode(picture()).decode()}
        code, result = self.manager.call('POST', '/api/products', payload)
        self.assertEqual(code, 201)
        self.assertEqual(result['product']['revision'], 1)
        return result['product']

    def files(self):
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.store.public.iterdir() if path.is_file()}

    def test_old_records_default_zero_and_upgrade_without_schema_change(self):
        product_id = uuid.uuid4().hex
        data = {'name': '旧档案测试', 'kind': 'catalog', 'description': '旧说明'}
        with self.store.db() as db:
            columns_before = [row['name'] for row in db.execute('PRAGMA table_info(products)')]
            db.execute('INSERT INTO products VALUES(?,?,?,?,?)',
                       (product_id, self.owner, server.dumps(data), server.now(), server.now()))
        self.assertEqual(self.store.product(product_id)['revision'], 0)
        code, result = self.manager.call('PATCH', f'/api/products/{product_id}',
                                         {'description': '已补充', 'expected_revision': 0})
        self.assertEqual(code, 200)
        self.assertEqual(result['product']['revision'], 1)
        with self.store.db() as db:
            self.assertEqual([row['name'] for row in db.execute('PRAGMA table_info(products)')], columns_before)

    def test_concurrent_http_edits_have_one_winner_and_preserve_winner_data(self):
        product = self.create()
        second = Client(self.base)
        second.call('POST', '/api/login', {'username': 'manager', 'password': self.password})
        barrier = threading.Barrier(2)
        def edit(client, description):
            barrier.wait(timeout=5)
            return client.call('PATCH', f"/api/products/{product['id']}",
                               {'description': description, 'expected_revision': product['revision']})
        with ThreadPoolExecutor(max_workers=2) as pool:
            future_a = pool.submit(edit, self.manager, '第一处修改')
            future_b = pool.submit(edit, second, '第二处修改')
            results = [future_a.result(timeout=10), future_b.result(timeout=10)]
        self.assertEqual(sorted(code for code, _ in results), [200, 409])
        winner = next(result['product'] for code, result in results if code == 200)
        conflict = next(result for code, result in results if code == 409)
        self.assertEqual(conflict['code'], 'product_conflict')
        actual = self.store.product(product['id'])
        self.assertEqual(actual['revision'], 2)
        self.assertEqual(actual['description'], winner['description'])
        self.assertNotIn('product', conflict)
        self.assertNotIn('PRIVATE_CAS_SECRET', json.dumps(conflict))

    def test_store_compare_and_swap_also_guards_legacy_clients_and_owner(self):
        product = self.create()
        before = self.store.product(product['id'])
        barrier = threading.Barrier(2)
        def save(description):
            payload = copy.deepcopy(before)
            payload['description'] = description
            barrier.wait(timeout=5)
            try:
                self.store.save_product(payload)
                return 200, description
            except server.Problem as failure:
                return failure.status, failure.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(save, description) for description in ('原客户端A', '原客户端B')]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(sorted(code for code, _ in results), [200, 409])
        self.assertEqual(self.store.product(product['id'])['description'], next(text for code, text in results if code == 200))
        changed_owner = self.store.product(product['id'])
        changed_owner['owner_id'] = 'forged-other-owner'
        with self.assertRaises(server.Problem) as failure:
            self.store.save_product(changed_owner)
        self.assertEqual(failure.exception.status, 404)
        self.assertEqual(self.store.product(product['id'])['owner_id'], self.owner)

    def test_invalid_revisions_and_stale_edits_leave_database_unchanged(self):
        product = self.create()
        before = self.store.product(product['id'])
        for revision in (None, True, False, 1.0, '1', -1, {}, [1]):
            with self.subTest(revision=repr(revision)):
                code, result = self.manager.call('PATCH', f"/api/products/{product['id']}",
                                                 {'description': '不能保存', 'expected_revision': revision})
                self.assertEqual((code, result['code']), (400, 'invalid_revision'))
                self.assertEqual(self.store.product(product['id']), before)
        code, result = self.manager.call('PATCH', f"/api/products/{product['id']}",
                                         {'description': '不能覆盖', 'expected_revision': 0})
        self.assertEqual((code, result['code']), (409, 'product_conflict'))
        self.assertEqual(self.store.product(product['id']), before)
        other = Client(self.base)
        other.call('POST', '/api/register', {'username': 'qa_cas_other', 'password': 'Testing-Conflict-123'})
        self.assertEqual(other.call('PATCH', f"/api/products/{product['id']}", {'name': '越权', 'expected_revision': 1})[0], 404)

    def test_edit_publish_unpublish_increment_and_stale_publish_makes_no_copy(self):
        product = self.create(image=True)
        path = f"/api/products/{product['id']}"
        code, edited = self.manager.call('PATCH', path, {'description': '新版木质说明', 'expected_revision': 1})
        self.assertEqual(code, 200)
        self.assertEqual(edited['product']['revision'], 2)
        before = self.store.product(product['id'])
        files_before = self.files()
        publish = {'purchase_url': 'https://example.com/cas-test', 'price': '测试价格',
                   'public_fields': ['description', 'image'], 'expected_revision': 1}
        code, result = self.manager.call('POST', path + '/publish', publish)
        self.assertEqual((code, result['code']), (409, 'product_conflict'))
        self.assertEqual(self.store.product(product['id']), before)
        self.assertEqual(self.files(), files_before)
        code, published = self.manager.call('POST', path + '/publish', {**publish, 'expected_revision': 2})
        self.assertEqual(code, 200)
        self.assertEqual(published['product']['revision'], 3)
        self.assertEqual(len(self.files()), 1)
        public = self.manager.call('GET', '/api/bootstrap')[1]['products']
        self.assertEqual(len(public), 1)
        self.assertEqual(public[0]['description'], '新版木质说明')
        self.assertNotIn('personal_notes', public[0])
        self.assertNotIn('PRIVATE_CAS_SECRET', json.dumps(public))
        published_before = self.store.product(product['id'])
        published_files = self.files()
        self.assertEqual(self.manager.call('POST', path + '/publish', {**publish, 'expected_revision': 2})[0], 409)
        self.assertEqual(self.store.product(product['id']), published_before)
        self.assertEqual(self.files(), published_files)
        self.assertEqual(self.manager.call('POST', path + '/unpublish', {'expected_revision': 2})[0], 409)
        self.assertTrue(self.store.product(product['id'])['published'])
        code, withdrawn = self.manager.call('POST', path + '/unpublish', {'expected_revision': 3})
        self.assertEqual(code, 200)
        self.assertEqual(withdrawn['product']['revision'], 4)
        self.assertFalse(withdrawn['product']['published'])
        self.assertEqual(self.manager.call('GET', public[0]['image_url'])[0], 404)
        self.assertEqual(self.manager.call('GET', product['asset_url'])[0], 200)

    def test_final_transaction_conflict_and_copy_failure_leave_no_new_files(self):
        product = self.create(image=True)
        stale = self.store.product(product['id'])
        fresh = copy.deepcopy(stale)
        fresh['description'] = '事务中的已保存修改'
        self.store.save_product(fresh)
        current = self.store.product(product['id'])
        source = self.store.uploads / current['normalized_image_path']
        with self.assertRaises(server.Problem) as failure:
            self.store.save_product(stale, expected_revision=1, public_image_source=source)
        self.assertEqual(failure.exception.code, 'product_conflict')
        self.assertEqual(self.files(), {})
        self.assertEqual(self.store.product(product['id']), current)
        with self.assertRaises(FileNotFoundError):
            self.store.save_product(current, expected_revision=2,
                                    public_image_source=self.store.uploads / 'missing-test-copy.jpg')
        self.assertEqual(self.files(), {})
        self.assertEqual(self.store.product(product['id']), current)


if __name__ == '__main__':
    unittest.main(verbosity=2)

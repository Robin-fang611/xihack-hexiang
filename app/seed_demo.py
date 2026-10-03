"""向隔离演示目录 app/.demo/ 写入虚构演示数据：创作者账号、已发布作品与上架商品。

- 全部资料为虚构演示示例，不代表真实商家、真实成交或真实在售商品。
- 不触碰正式数据目录 .local/；重复执行时若已初始化则直接退出。
- 运行：python3 seed_demo.py [--force]（--force 会先删除 .demo 重新写入）
"""
import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path

import server
import services

DEMO_DIR = Path(__file__).resolve().parent / '.demo'
DEMO_PASSWORD = 'xihack2026'

CREATORS = [
    {'username': 'shanke', 'display_name': '山客香铺'},
    {'username': 'songjian', 'display_name': '松间工作室'},
    {'username': 'xiangyou', 'display_name': '香友小西', 'role': 'user'},
]

WORKS = [
    {'owner': 'shanke', 'components': [('F02', 'main'), ('F04', 'accent')],
     'name': '松声涧语', 'scenario': '晨间阅读', 'intent': '以雪松作主调、乳香收尾的清润木质案头。',
     'preferred': ['woody', 'citrus'], 'deemphasized': [], 'excluded': [],
     'note': '演示作品：为清晨书桌设计的一炉清润木质香，非真实在售商品。'},
    {'owner': 'shanke', 'components': [('F01', 'main'), ('F03', 'support'), ('F05', 'accent')],
     'name': '暮山紫', 'scenario': '夜间阅读', 'intent': '檀香的奶感打底，安息香与丁香收束成温甜的夜读气息。',
     'preferred': ['woody', 'sweet', 'spicy'], 'deemphasized': [], 'excluded': [],
     'note': '演示作品：夜读时的温甜木质构图，公开内容仅含设计事实，非真实在售商品。'},
    {'owner': 'songjian', 'components': [('F05', 'main'), ('F02', 'support')],
     'name': '一盏辛温', 'scenario': '待客与阅读', 'intent': '丁香花蕾作主调、雪松作支撑的辛温待客之香。',
     'preferred': ['spicy', 'woody'], 'deemphasized': [], 'excluded': [],
     'note': '演示作品：待客场景的辛温构图，非真实在售商品。'},
]

PRODUCTS = [
    {'owner': 'shanke', 'name': '山客 · 沉水檀线香（演示）', 'brand': '山客香铺', 'form': 'incense',
     'spec': '40克 / 约50支', 'description': '演示资料：虚构示例线香，木质、微甜、烟少。非真实在售商品。',
     'notes': '木质、奶油、微甜', 'ingredients': '檀香粉、楠木皮粘粉（示例标签声明，未核对）',
     'source_url': 'https://example.com/shanke-demo', 'price': '¥68 / 40克（演示标注，以商家页为准）',
     'purchase_url': 'https://example.com/shanke-demo/incense', 'public_fields': ['description', 'notes', 'ingredients', 'source_url', 'price']},
    {'owner': 'shanke', 'name': '山客 · 调香体验装（演示）', 'brand': '山客香铺', 'form': 'essential_oil',
     'spec': '3支 × 1ml', 'description': '演示资料：虚构示例体验装，含雪松、乳香、丁香单方精油各一支，供对照调香设计。非真实在售商品。',
     'notes': '木质、树脂、辛香', 'ingredients': '雪松精油、乳香精油、丁香花蕾精油（示例声明，未核对）',
     'source_url': 'https://example.com/shanke-demo', 'price': '¥39 / 套（演示标注，以商家页为准）',
     'purchase_url': 'https://example.com/shanke-demo/trial', 'public_fields': ['description', 'notes', 'ingredients', 'price']},
    {'owner': 'songjian', 'name': '松间 · 雪松香薰蜡烛（演示）', 'brand': '松间工作室', 'form': 'candle',
     'spec': '180g', 'description': '演示资料：虚构示例香薰蜡烛，木质与青绿方向，适合书房。非真实在售商品。',
     'notes': '木质、青绿', 'ingredients': '大豆蜡、雪松香料（示例声明，未核对）',
     'source_url': 'https://example.com/songjian-demo', 'price': '¥129 / 180g（演示标注，以商家页为准）',
     'purchase_url': 'https://example.com/songjian-demo/candle', 'public_fields': ['description', 'notes', 'ingredients', 'source_url', 'price']},
]


def seed():
    store = server.Store(DEMO_DIR)
    rules = services._rules()
    profiles = {p['id']: p for p in rules['profiles']}
    with store.db() as db:
        already = db.execute('SELECT 1 FROM users WHERE username=?', (CREATORS[0]['username'],)).fetchone()
    if already:
        print(f'演示数据已存在（{DEMO_DIR}），如需重置请使用 --force。')
        return
    from server import now, password_hash, dumps
    for spec in CREATORS:
        with store.db() as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',
                       (uuid.uuid4().hex, spec['username'], spec['display_name'],
                        spec.get('role', 'manager'), password_hash(DEMO_PASSWORD), now()))
    owners = {}
    with store.db() as db:
        for row in db.execute('SELECT id, username FROM users'):
            owners[row['username']] = row['id']
    for spec in WORKS:
        payload = {
            'components': [{'profile_id': pid, 'role': role} for pid, role in spec['components']],
            'name': spec['name'], 'scenario': spec['scenario'], 'intent': spec['intent'],
            'preferred_facets': spec['preferred'], 'deemphasized_facets': spec['deemphasized'],
            'excluded_ids': spec['excluded'],
        }
        for part in payload['components']:
            if part['profile_id'] not in profiles:
                raise SystemExit(f'演示作品引用了未知材料编号：{part["profile_id"]}')
        evaluated = services.evaluate_board(payload)
        if evaluated.get('status') != 'ok':
            raise SystemExit(f'演示作品核验失败：{evaluated}')
        design = evaluated['design']
        design.update(published=True, public_note=spec['note'], published_at=now())
        with store.db() as db:
            db.execute('INSERT INTO designs VALUES(?,?,?,?)', (uuid.uuid4().hex, owners[spec['owner']], dumps(design), now()))
    for spec in PRODUCTS:
        fields = {key: spec.get(key, '') for key in server.FIELDS}
        fields.update({key: spec.get(key, '') for key in ('brand', 'spec')})
        product = {**fields, 'id': uuid.uuid4().hex, 'owner_id': owners[spec['owner']],
                   'kind': 'catalog', 'created_at': now(), 'updated_at': now(),
                   'published': True, 'public_fields': spec['public_fields'],
                   'purchase_url': server.valid_url(spec['purchase_url'], commerce=True),
                   'price': spec['price'], 'extracted_text': '',
                   'analysis': services.analyze_product(fields)}
        store.save_product(product)
    notes = ['西客松合香 · 演示数据说明', '',
             '本目录为隔离演示数据（app/.demo/），全部账号、作品与商品均为虚构示例，',
             '不代表真实商家入驻、真实成交或真实在售商品；购买链接指向 example.com 示例页。', '',
             '演示账号（密码统一为 ' + DEMO_PASSWORD + '）：',
             '  创作者（OPC）：shanke（山客香铺）、songjian（松间工作室）',
             '  香友：xiangyou', '',
             '启动：双击 启动演示.command，或 python3 server.py --port 8875 --data-dir .demo',
             '入口：http://127.0.0.1:8875', '',
             '本目录不进入版本控制，不参与正式 .local/ 数据。']
    target = DEMO_DIR / '演示说明.txt'
    target.write_text('\n'.join(notes) + '\n')
    print('演示数据写入完成：' + str(DEMO_DIR))
    print('演示账号与说明：' + str(target))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='删除现有 .demo 后重新写入')
    args = parser.parse_args()
    if args.force and DEMO_DIR.exists():
        shutil.rmtree(DEMO_DIR)
    seed()


if __name__ == '__main__':
    main()

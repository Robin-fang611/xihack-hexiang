"""本地、无网络的资料与设计服务；规则归类不冒充模型或感官测量。"""
from __future__ import annotations

import copy
import importlib.util
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('scent_design_rules', ROOT / '知识库' / '数字调香.py')
_engine = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_engine)
ROLES = {'main': '主调', 'support': '支撑', 'accent': '点缀'}
SCOPE = '来源支持的数字设计意图；未制作、未实闻，不提供投料或健康疗效。'


def _rules():
    rules = _engine.load_rules()
    _engine.validate_rules(rules)
    return rules


def _text(value, limit=12000):
    return value.strip()[:limit] if isinstance(value, str) else ''


def _url(value):
    value = _text(value, 2048)
    try:
        parsed = urlsplit(value)
        return value if parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username else ''
    except ValueError:
        return ''


def _failure(status, reason, **details):
    return {'status': status, 'reason': reason, **details}


def _preferences(payload, rules):
    preferred = _engine.normalize_facets(payload.get('preferred_facets', []), rules)
    deemphasized = _engine.normalize_facets(payload.get('deemphasized_facets', []), rules)
    unknown = (set(preferred) | set(deemphasized)) - rules['facets'].keys()
    if unknown:
        raise ValueError('未知描述词：' + '、'.join(sorted(unknown)))
    if set(preferred) & set(deemphasized):
        raise ValueError('同一方向不能同时设为喜欢和减弱。')
    return preferred, deemphasized


def _exclusions(payload, profiles):
    excluded = payload.get('excluded_ids', [])
    if not isinstance(excluded, list) or any(not isinstance(value, str) for value in excluded):
        raise ValueError('排除材料须为编号数组。')
    unknown = set(excluded) - profiles.keys()
    if unknown:
        raise ValueError('未知排除材料：' + '、'.join(sorted(unknown)))
    return list(dict.fromkeys(excluded))


def _component(profile, role, sources, rules):
    source = sources[profile['source_id']]
    return {
        'profile_id': profile['id'], 'name': profile['name'], 'role': role,
        'role_label': ROLES[role], 'form': profile['form'],
        'primary_family': profile['primary_family'],
        'reported_facets': list(profile['reported_facets']),
        'display_facets': [rules['facets'][f] for f in profile['reported_facets']],
        'source_id': source['id'], 'source_url': source['url'], 'source_locator': source['locator'],
        'profile_status': profile['profile_status'], 'sample_status': profile['sample_status'],
        'mixing_evidence': profile['mixing_evidence'],
    }


def bootstrap_data():
    rules = _rules()
    sources = {s['id']: s for s in rules['sources']}
    profiles = []
    for original in rules['profiles']:
        profile = copy.deepcopy(original)
        source = sources[profile['source_id']]
        profile.update(source_url=source['url'], source_locator=source['locator'],
                       display_facets=[rules['facets'][f] for f in profile['reported_facets']])
        profiles.append(profile)
    knowledge = json.loads((ROOT / '知识库' / '知识条目.json').read_text())
    presets = json.loads((ROOT / 'app' / 'presets.json').read_text())['presets']
    for preset in presets:
        evaluated = evaluate_board(preset)
        if evaluated['status'] != 'ok':
            raise ValueError('invalid_design_preset:' + preset['id'])
        preset['components'] = evaluated['design']['components']
        preset['sources'] = evaluated['design']['sources']
        preset['families'] = evaluated['design']['families']
        preset['main_family'] = evaluated['design']['main_family']
    return {
        'profiles': profiles, 'facets': copy.deepcopy(rules['facets']),
        'vocabulary': copy.deepcopy(rules.get('vocabulary_bridge', [])),
        'presets': presets, 'knowledge': knowledge,
        'sources': copy.deepcopy(rules['sources']) + copy.deepcopy(knowledge['sources']),
        'roles': copy.deepcopy(ROLES), 'data_version': rules['schema_version'], 'scope': SCOPE,
        'analysis_method': '本机标准库规则归类，无外部模型或网页抓取',
    }


def compose_design(payload):
    if not isinstance(payload, dict):
        return _failure('invalid_request', '请求须为对象。', candidates=[])
    request = copy.deepcopy(payload)
    rules = _rules()
    try:
        _exclusions(request, {p['id']: p for p in rules['profiles']})
        if 'limit' in request:
            if isinstance(request['limit'], bool) or not isinstance(request['limit'], int):
                raise ValueError('候选数量须为整数。')
        if request.get('main_family') and not isinstance(request['main_family'], str):
            raise ValueError('主家族须为描述词。')
        if request.get('locked_main_id') and not isinstance(request['locked_main_id'], str):
            raise ValueError('固定主调须为材料编号。')
        return _engine.compose(request, rules)
    except (TypeError, ValueError) as exc:
        return _failure('invalid_request', str(exc), candidates=[])


def evaluate_board(payload):
    """核验自由构图，返回可保存设计；客户端的来源/许可/状态字段不可覆盖核验结果。"""
    if not isinstance(payload, dict):
        return _failure('invalid_request', '请求须为对象。')
    rules = _rules()
    if payload.get('mode', rules['mode']) != rules['mode']:
        return _failure('unsupported_domain', '当前构图使用现代参照，不迁移为香粉、加热或燃香。')
    raw = payload.get('components')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 3:
        return _failure('invalid_components', '请选择一至三种材料，并设置一个主调。')
    profiles = {p['id']: p for p in rules['profiles']}
    sources = {s['id']: s for s in rules['sources']}
    try:
        preferred, deemphasized = _preferences(payload, rules)
        excluded = _exclusions(payload, profiles)
    except ValueError as exc:
        return _failure('invalid_request', str(exc))
    components, seen_ids, seen_roles = [], set(), set()
    for selection in raw:
        if not isinstance(selection, dict):
            return _failure('invalid_components', '每个位置须包含材料编号和角色。')
        profile_id = selection.get('profile_id')
        role = selection.get('role', selection.get('role_id'))
        if not isinstance(profile_id, str) or profile_id not in profiles:
            return _failure('unknown_material', '材料不在已核对的当前资料池。')
        if not isinstance(role, str) or role not in ROLES:
            return _failure('invalid_role', '角色只能是主调、支撑或点缀。')
        if profile_id in excluded:
            return _failure('constraint_conflict', '已排除的材料不能进入构图。')
        if profile_id in seen_ids or role in seen_roles:
            return _failure('duplicate_component', '同一材料和同一角色各只能出现一次。')
        profile = profiles[profile_id]
        if selection.get('form', profile['form']) != profile['form']:
            return _failure('unsupported_form', '所选材料形态与来源档案不一致。')
        seen_ids.add(profile_id)
        seen_roles.add(role)
        components.append((role, profile))
    if 'main' not in seen_roles:
        return _failure('missing_main', '构图需要一个主调；支撑和点缀可以留空。')
    main = next(p for role, p in components if role == 'main')
    if payload.get('locked_main_id') and payload['locked_main_id'] != main['id']:
        return _failure('constraint_conflict', '构图没有保留已固定的主调。')
    if payload.get('main_family'):
        try:
            main_family = _engine.normalize_facets([payload['main_family']], rules)[0]
        except (ValueError, IndexError):
            return _failure('invalid_request', '主家族须为描述词。')
        if main_family != main['primary_family']:
            return _failure('constraint_conflict', '指定主家族与主调档案不一致。')
    families = sorted(set().union(*(set(p['reported_facets']) for _, p in components)))
    matched = sorted(set(preferred) & set(families))
    unmatched = sorted(set(preferred) - set(families))
    # 保存自由构图允许保留尚未满足的设计目标，不声称目标已经实现。
    ordered = sorted(components, key=lambda item: list(ROLES).index(item[0]))
    design = {key: copy.deepcopy(payload[key]) for key in (
        'name', 'scenario', 'description', 'intent', 'preset_id', 'starting_preset_id',
        'user_notes', 'raw_preferences', 'raw_exclusions', 'preferred_facets', 'deemphasized_facets',
        'locked_main_id') if key in payload}
    design.update({
        'name': _text(payload.get('name'), 200) or '未命名香笺',
        'scenario': _text(payload.get('scenario'), 400),
        'components': [_component(p, role, sources, rules) for role, p in ordered],
        'preferred_facets': preferred, 'deemphasized_facets': deemphasized, 'excluded_ids': excluded,
        'families': families, 'display_facets': [rules['facets'][f] for f in families],
        'main_family': main['primary_family'], 'matched_preferences': matched,
        'unmatched_preferences': unmatched, 'metrics': _engine.evaluate(components, preferred, deemphasized, rules),
        'sources': [copy.deepcopy(sources[source_id]) for source_id in dict.fromkeys(p['source_id'] for _, p in ordered)],
        'composition_kind': 'composite_concept' if len(components) > 1 else 'single_material_reference',
        'status': 'untested_composite_design', 'stamp': '意', 'mode': rules['mode'],
        'data_version': rules['schema_version'], 'manufacturing_approved': False, 'sensory_verified': False,
        'historical_reconstruction': False, 'scope': SCOPE,
        'unknowns': ['标签未报道不等于不存在', '家族表示来源中已报道的单材侧面，不表示组合实闻',
                     '没有制作比例、工艺或载体适配', '没有实际气味、排除过敏原或健康疗效保证'],
    })
    if unmatched:
        design['unknowns'].append('所选材料未报道部分目标：' + '、'.join(rules['facets'][f] for f in unmatched))
    return {'status': 'ok', 'design': design}


def _strings(value):
    if isinstance(value, str):
        return [_text(part) for part in value.splitlines() if _text(part)]
    if isinstance(value, list):
        return [_text(part) for part in value if isinstance(part, str) and _text(part)]
    return []


def _statement(text, field, source_url='', kind='uploader_provided_text'):
    return {'text': text, 'source': {'kind': kind, 'field': field, 'url': source_url},
            'verification': '提供者声明；未独立核对品牌原文或实物'}


# 自拟关键词桥：只解释气味文字，不识别真实配料。香脂、奶油、温暖不并入甜香。
_NOTE_WORDS = {
    'woody': ('木质', '木香', '檀香', '雪松', 'woody', 'wood', 'sandalwood', 'cedarwood'),
    'resinous': ('树脂', 'resinous'), 'herbal': ('草本', 'herbal'),
    'floral': ('花香', '玫瑰', '桂花', 'floral', 'rose'),
    'fruity': ('果香', '水果', 'fruity'), 'citrus': ('柑橘', '柠檬', '橙皮', 'citrus'),
    'spicy': ('辛香', '香辛', '丁香', '肉桂', 'spicy'),
    'sweet': ('甜香', '甜感', '香草', 'sweet', 'vanilla'),
    'earthy': ('泥土', '土壤', 'earthy'), 'smoky': ('烟熏', '烟气', 'smoky'),
    'balsamic': ('香脂', 'balsamic'), 'creamy': ('奶油', 'creamy'),
    'warm': ('温暖', 'warm'), 'leathery': ('皮革', 'leathery'),
    'amber': ('琥珀', 'amber'), 'powdery': ('粉感', 'powdery'),
    'green': ('青绿', 'green'), 'terpenic': ('萜烯', 'terpenic'),
    'peppery': ('胡椒', 'peppery'), 'medicinal': ('药感', 'medicinal'),
}


def _note_matches(text):
    hits = {}
    for family, words in _NOTE_WORDS.items():
        for word in words:
            pattern = (r'\b' + re.escape(word) + r'\b') if word.isascii() else re.escape(word)
            for match in re.finditer(pattern, text, re.I):
                before = text[max(0, match.start() - 8):match.start()]
                if re.search(r'(?:不|无|没有|非).{0,3}$|\b(?:no|not|without)\s*$', before, re.I):
                    continue
                if word == '玫瑰' and text[match.end():].startswith('木'):
                    continue
                hits.setdefault(family, []).append(word)
                break
    return {key: list(dict.fromkeys(words)) for key, words in hits.items()}


def analyze_product(payload, extracted_text=''):
    if not isinstance(payload, dict):
        raise ValueError('产品资料须为对象。')
    source_url = _url(payload.get('source_url'))
    identity = {key: _text(payload.get(key), 2048 if key == 'source_url' else 400)
                for key in ('name', 'brand', 'form', 'spec')}
    identity.update(source_url=source_url, information_status='上传者提供；未验证商品或材料身份')
    ingredients = [_statement(value, 'ingredients', source_url) for value in _strings(payload.get('ingredients'))]
    notes = [_statement(value, 'notes', source_url) for value in _strings(payload.get('notes'))]
    observations = [_statement(value, 'personal_notes', kind='personal_observation_provided')
                    for value in _strings(payload.get('personal_notes'))]
    description = _text(payload.get('description'))
    if description and _note_matches(description):
        notes.append(_statement(description, 'description', source_url))
    document = _text(extracted_text, 60000)
    unclassified_document = False
    for line in document.splitlines():
        labelled = re.match(r'^\s*(成分(?:表|声明)?|配料(?:表)?|INCI|ingredients?|香调|香气|气味|notes?)\s*[:：]\s*(.+)$', line, re.I)
        if not labelled:
            if line.strip():
                unclassified_document = True
            continue
        field, content = labelled.groups()
        row = _statement(_text(content), 'extracted_text', source_url, 'uploaded_document_extracted_text')
        row['source']['label'] = field
        (ingredients if re.match(r'成分|配料|INCI|ingredients?', field, re.I) else notes).append(row)
    inferences, families = [], set()
    for row in notes:
        for family, words in _note_matches(row['text']).items():
            families.add(family)
            inferences.append({'family': family, 'kind': 'project_keyword_classification',
                               'text': '按提供的气味文字归入项目描述家族，不是成分鉴定或实闻。',
                               'basis': {'text': row['text'], 'source': row['source'], 'matched_terms': words},
                               'verification': '系统规则归类；实际感知未验证'})
    gaps = ['未公开的真实配方与比例保持未知', '商品身份、真实成分、感官与安全性未独立验证']
    for key, label in (('name', '产品名称'), ('brand', '品牌'), ('form', '产品形态'), ('spec', '规格')):
        if not identity[key]:
            gaps.append('未提供' + label)
    if not ingredients:
        gaps.append('没有明确成分声明；香调不能替代成分表')
    if not notes:
        gaps.append('没有明确香调或可归类的气味描述')
    if not source_url:
        gaps.append('没有有效外部来源链接；上传资料仍可分析')
    if source_url:
        gaps.append('来源链接仅由提供者填写，系统未自动访问或验证网页')
    if unclassified_document:
        gaps.append('附件含未明确标为成分/香调的文字，未自动猜测其用途')
    if isinstance(extracted_text, str) and len(extracted_text) > 60000:
        gaps.append('附件文字仅分析前60000字符')
    unsupported = []
    health_pattern = r'助眠|安神|治疗|治愈|抗焦虑|抗抑郁|消毒|净化空气|无过敏|不过敏|零刺激|绝对安全|100%安全'
    for field in ('description', 'notes', 'ingredients', 'personal_notes'):
        for text in _strings(payload.get(field)):
            if re.search(health_pattern, text, re.I):
                unsupported.append({'text': text, 'source': {'kind': 'provided_text', 'field': field, 'url': source_url},
                                    'reason': '文本涉及功效或安全表述；当前资料分析不能证明这些结论。'})
    if document and re.search(health_pattern, document, re.I):
        unsupported.append({'text': '附件文字涉及功效或安全表述',
                            'source': {'kind': 'uploaded_document_extracted_text', 'field': 'extracted_text', 'url': source_url},
                            'reason': '文字提取不能验证临床功效或安全。'})
    return {'identity': identity, 'ingredient_declarations': ingredients, 'reported_notes': notes,
            'personal_observations': observations, 'system_inferences': inferences,
            'families': sorted(families), 'gaps': gaps, 'unsupported_claims': unsupported,
            'status': '资料分析', 'analysis_method': '本机关键词与明确标签规则；未使用LLM、OCR气味识别或配方反推',
            'source_fetched': False, 'manufacturing_approved': False}


def match_products(design, public_products):
    """输入须为服务端筛选后的公开投影；只按资料方向匹配，不核定配方与实闻。"""
    if not isinstance(design, dict) or not isinstance(public_products, list):
        return _failure('invalid_request', '需要设计对象与公开商品数组。', matches=[])
    design = design.get('design', design)
    if not isinstance(design, dict):
        return _failure('invalid_request', '设计结构不正确。', matches=[])
    rules = _rules()
    profiles = {p['id']: p for p in rules['profiles']}
    families = set(design.get('families', [])) & rules['facets'].keys()
    if not families:
        for item in design.get('components', []):
            profile = profiles.get(item.get('profile_id')) if isinstance(item, dict) else None
            if profile:
                families.update(profile['reported_facets'])
    if not families:
        return _failure('no_supported_preferences', '设计尚无来源支持的资料方向。', matches=[])
    try:
        excluded = _exclusions(design, profiles)
    except ValueError as exc:
        return _failure('invalid_request', str(exc), matches=[])
    matches, skipped = [], []
    allowed = ('id', 'name', 'brand', 'form', 'spec', 'description', 'notes', 'ingredients', 'source_url',
               'price', 'purchase_url', 'image_url', 'seller_name', 'updated_at')
    for original in public_products:
        if not isinstance(original, dict) or original.get('published') is False:
            continue
        product = {key: copy.deepcopy(original[key]) for key in allowed if key in original}
        # 即便错误传入了完整档案，也不使用或输出个人观察/附件文字。
        analysis = analyze_product(product)
        shared = sorted(families & set(analysis['families']))
        if not shared:
            continue
        declarations = ' '.join(row['text'] for row in analysis['ingredient_declarations'])
        declared_exclusions = []
        for profile_id in excluded:
            profile = profiles[profile_id]
            short_name = re.split(r'精油|乙醇提取物', profile['name'])[0]
            species = ' '.join(profile['source_plant_name'].split()[:2])
            if any(term and term.casefold() in declarations.casefold() for term in (profile_id, short_name, species)):
                declared_exclusions.append(profile_id)
        if declared_exclusions:
            skipped.append({'product_id': product.get('id'), 'reason': '提供的成分声明涉及已排除材料，保守移出候选。',
                            'declared_exclusion_matches': declared_exclusions})
            continue
        product['analysis'] = {key: analysis[key] for key in ('families', 'reported_notes', 'system_inferences', 'gaps')}
        exclusions_unknown = bool(excluded)
        matches.append({'product': product, 'matched_families': shared,
                        'display_families': [rules['facets'][f] for f in shared],
                        'reasons': ['公开气味资料与设计的来源方向有共同项目标签：' + '、'.join(rules['facets'][f] for f in shared),
                                    '依据上传者提供的香调文字与系统规则归类，不代表同配方或真实气味相同。'],
                        'evidence_status': 'public_provider_text_and_project_classification',
                        'ranking_index': len(shared), 'ranking_meaning': '共同资料标签数量，仅为工程排序',
                        'exclusion_status': 'unknown_not_guaranteed' if exclusions_unknown else 'no_exclusions_requested',
                        'unknowns': ['实际闻香喜好、真实成分、浓度及载体适配未验证',
                                     '未声明某材料不等于不含；不能保证满足材料或过敏原排除条件'],
                        'status': '资料方向相近，待核对'})
    matches.sort(key=lambda item: (-item['ranking_index'], str(item['product'].get('id', ''))))
    return {'status': 'ok', 'matches': matches, 'skipped': skipped,
            'scope': '现成商品的公开资料匹配；不提供同配方、实闻相似度或安全保证。'}

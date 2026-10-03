"""来源约束下的构图候选，不预测真实气味，不生成制作比例。"""
import itertools
import json
from pathlib import Path


def load_rules():
    return json.loads(Path(__file__).with_name('复合调香规则.json').read_text())


def validate_rules(rules):
    sources = {s['id']: s for s in rules['sources']}
    seen = set()
    for p in rules['profiles']:
        if p['id'] in seen:
            raise ValueError('duplicate_profile')
        seen.add(p['id'])
        if p['domain'] != rules['mode']:
            raise ValueError('cross_domain_profile')
        if p['form'] not in ('essential_oil', 'resinoid_extract'):
            raise ValueError('unsupported_form')
        if p['source_id'] not in sources:
            raise ValueError('missing_source')
        if sources[p['source_id']]['status'] != 'relevant_body_read':
            raise ValueError('source_not_read')
        if p.get('profile_status') != 'supplier_report_checked':
            raise ValueError('profile_not_checked')
        if sources[p['source_id']].get('kind') != 'manufacturer_material_profile':
            raise ValueError('source_not_material_profile')
        if set(p['reported_facets']) - rules['facets'].keys():
            raise ValueError('unknown_facet')
        if p['manufacturing_approved']:
            raise ValueError('manufacturing_not_validated')


def normalize_facets(values, rules):
    """项目词汇桥只翻译用户词，不给材料增加任何侧面。"""
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple)) or any(not isinstance(v, str) for v in values):
        raise ValueError('facets_must_be_strings')
    aliases = {label: canonical for canonical, label in rules['facets'].items()}
    for word in rules.get('vocabulary_bridge', []):
        aliases[word['id']] = word['canonical_facet']
        aliases[word['term']] = word['canonical_facet']
    return list(dict.fromkeys(aliases.get(value.strip(), value.strip()) for value in values if value.strip()))


def evaluate(components, preferred, deemphasized, rules):
    preferred = normalize_facets(preferred, rules)
    deemphasized = normalize_facets(deemphasized, rules)
    weights = rules['composition_policy']['role_score_weights']
    desired_index = avoided_index = 0
    for role, profile in components:
        facets = set(profile['reported_facets'])
        desired_index += weights[role] * len(facets & set(preferred))
        avoided_index += weights[role] * len(facets & set(deemphasized))
    # 这些系数只作工程排序；不表示克数、质量比、感官强度或气味概率。
    coefficients = rules['composition_policy']['ranking_coefficients']
    score = (coefficients['preferred'] * desired_index
             - coefficients['deemphasized'] * avoided_index
             - coefficients['complexity'] * len(components))
    return {'design_match_index': desired_index,
            'reported_deemphasized_facet_index': avoided_index,
            'ranking_score': score}


def compose(request, rules=None):
    rules = rules or load_rules()
    validate_rules(rules)
    if not isinstance(request, dict):
        return {'status': 'invalid_request', 'candidates': [], 'reason': '请求须为对象。'}
    if request.get('mode', rules['mode']) != rules['mode']:
        return {'status': 'unsupported_domain', 'candidates': [],
                'reason': '本材料池只支持现代调香参照，不能移为香粉、加热或燃香。'}
    try:
        preferred = normalize_facets(request.get('preferred_facets', []), rules)
        deemphasized = normalize_facets(request.get('deemphasized_facets', []), rules)
    except ValueError:
        return {'status': 'invalid_request', 'candidates': [], 'reason': '偏好和减弱项须为描述词数组。'}
    unknown = (set(preferred) | set(deemphasized)) - rules['facets'].keys()
    if unknown:
        return {'status': 'unknown_descriptors', 'candidates': [], 'unknown': sorted(unknown)}
    if set(preferred) & set(deemphasized):
        return {'status': 'constraint_conflict', 'candidates': [],
                'reason': '同一方向不能同时设为喜欢和减弱，请明确要保留的条件。'}
    all_ids = {p['id'] for p in rules['profiles']}
    excluded = set(request.get('excluded_ids', []))
    if excluded - all_ids:
        return {'status': 'unknown_exclusions', 'candidates': [], 'unknown': sorted(excluded - all_ids)}
    locked = request.get('locked_main_id')
    if locked and (locked not in all_ids or locked in excluded):
        return {'status': 'constraint_conflict', 'candidates': [], 'reason': '固定主调不存在或已被排除。'}
    pool = [p for p in rules['profiles'] if p['id'] not in excluded]
    locked_profile = next((p for p in pool if p['id'] == locked), None)
    reported = set().union(*(set(p['reported_facets']) for p in pool)) if pool else set()
    if preferred and not (set(preferred) & reported):
        return {'status': 'no_supported_preferences', 'candidates': [],
                'unmatched_preferences': preferred,
                'reason': '当前资料池未报道这些偏好方向；不据此给材料补造标签。'}
    explicit_family = request.get('main_family')
    family = None
    if explicit_family:
        try:
            normalized_family = normalize_facets([explicit_family], rules)
        except ValueError:
            return {'status': 'invalid_request', 'candidates': [], 'reason': '主家族须为描述词。'}
        if not normalized_family:
            return {'status': 'invalid_request', 'candidates': [], 'reason': '主家族不能为空白。'}
        family = normalized_family[0]
    if locked_profile and family and locked_profile['primary_family'] != family:
        return {'status': 'constraint_conflict', 'candidates': [], 'reason': '显式家族与固定主调冲突，请选择要保留的条件。'}
    if locked_profile:
        mains = [locked_profile]
    elif family:
        mains = [p for p in pool if p['primary_family'] == family]
    elif preferred:
        main_families = set(preferred) & {p['primary_family'] for p in pool}
        mains = ([p for p in pool if p['primary_family'] in main_families] if main_families
                 else [p for p in pool if set(p['reported_facets']) & set(preferred)])
    else:
        # 唯一可用参照可以明确显示；多个材料时不替用户默认木质目标。
        mains = pool if len(pool) == 1 else []
    if not mains:
        return {'status': 'no_supported_main', 'candidates': [], 'reason': '资料池内没有满足条件的主调，不解除排除条件。'}
    results = {}
    sources = {s['id']: s for s in rules['sources']}
    for main in mains:
        others = [p for p in pool if p['id'] != main['id']]
        assignments = [[('main', main)]]
        assignments += [[('main', main), ('support', support)] for support in others]
        assignments += [[('main', main), ('support', support), ('accent', accent)]
                        for support, accent in itertools.permutations(others, 2)]
        for components in assignments:
            metrics = evaluate(components, preferred, deemphasized, rules)
            key = tuple(sorted(p['id'] for _, p in components))
            matched = sorted(set().union(*(set(p['reported_facets']) for _, p in components)) & set(preferred))
            candidate = {
                'composition_kind': 'composite_concept' if len(components) > 1 else 'single_material_reference',
                'components': [{'profile_id': p['id'], 'name': p['name'], 'role': role,
                                'role_label': rules['composition_policy']['role_display'][role],
                                'form': p['form'], 'reported_facets': p['reported_facets'],
                                'source_id': p['source_id'],
                                'source_url': sources[p['source_id']]['url'],
                                'source_locator': sources[p['source_id']]['locator'],
                                'profile_status': p['profile_status'], 'sample_status': p['sample_status']}
                               for role, p in components],
                'metrics': metrics, 'matched_preferences': matched,
                'unmatched_preferences': sorted(set(preferred) - set(matched)),
                'status': 'untested_composite_design',
                'manufacturing_approved': False,
                'unknowns': ['标签未报道不等于不存在', '组合气味尚未实闻', '没有制作比例或载体适配', '排序不是感官强度预测']
            }
            if key not in results or metrics['ranking_score'] > results[key]['metrics']['ranking_score']:
                results[key] = candidate
    ordered = sorted(results.values(), key=lambda c: (-c['metrics']['ranking_score'],
                                                     tuple(p['profile_id'] for p in c['components'])))
    limit = max(1, min(int(request.get('limit', 2)), 5))
    status = 'ok' if any(len(c['components']) > 1 for c in ordered[:limit]) else 'single_reference_only'
    return {'status': status, 'mode': rules['mode'], 'request': request,
            'data_version': rules['schema_version'], 'candidates': ordered[:limit],
            'normalized_preferences': preferred, 'normalized_deemphasized': deemphasized,
            'scope': '有来源的数字构图候选；未进行真实配伍与闻香验证。'}


def demo():
    rules = load_rules()
    profiles = {p['id']: p for p in rules['profiles']}
    initial = [('main', profiles['F01']), ('support', profiles['F03']), ('accent', profiles['F05'])]
    request = {'preferred_facets': ['woody'], 'deemphasized_facets': ['sweet'],
               'locked_main_id': 'F01', 'limit': 2}
    before = {'components': [{'profile_id': p['id'], 'role': role, 'name': p['name']} for role, p in initial],
              'metrics_for_updated_intent': evaluate(initial, ['woody'], ['sweet'], rules),
              'status': 'project_authored_untested_starting_design'}
    after = compose(request, rules)
    old = {p['id']: role for role, p in initial}
    for candidate in after['candidates']:
        new = {p['profile_id']: p['role'] for p in candidate['components']}
        candidate['changes_from_start'] = {
            'added': [profiles[i]['name'] for i in sorted(new.keys() - old.keys())],
            'removed': [profiles[i]['name'] for i in sorted(old.keys() - new.keys())],
            'role_changes': [{'name': profiles[i]['name'], 'from': old[i], 'to': new[i]}
                             for i in sorted(old.keys() & new.keys()) if old[i] != new[i]],
            'kept_main': new.get('F01') == 'main'
        }
    return {'example': '保留木质主调，降低已报道甜香参照的设计主次', 'before': before, 'after': after,
            'meaning': '同一资料域内改换构图角色与参照，指标只检查设计改动，不证明混合后更木质或不甜。'}


if __name__ == '__main__':
    result = demo()
    out = Path(__file__).with_name('复合调香演示结果.json')
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'before': result['before']['metrics_for_updated_intent'],
                      'after': [c['metrics'] for c in result['after']['candidates']],
                      'components': [[p['profile_id'] for p in c['components']] for c in result['after']['candidates']],
                      'scope': result['meaning']}, ensure_ascii=False, indent=2))

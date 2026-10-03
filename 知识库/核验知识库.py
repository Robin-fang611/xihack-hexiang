"""核对引用、状态与形态边界。不能代替原文审读、实闻或配方审核。"""

import argparse
import copy
import json
from pathlib import Path


def validate(data):
    errors = []
    ids = []
    sources = {s['id']: s for s in data['sources']}
    vocabulary = {v['id']: v for v in data['vocabulary']}
    facts = [f for m in data['materials'] for f in m['facts']]
    facts += data['culture_claims']
    fact_ids = {f['id'] for f in facts}
    rule_ids = {r['id'] for r in data['rules']}
    formula_ids = {f['id'] for f in data['historical_formulas']}
    for key in ('sources', 'materials', 'culture_claims', 'historical_formulas',
                'vocabulary', 'rules', 'qa_cases'):
        ids += [item['id'] for item in data[key]]
    for material in data['materials']:
        ids += [f['id'] for f in material['facts']]
        ids += [f['id'] for f in material['forms']]
    if len(ids) != len(set(ids)):
        errors.append('存在重复记录ID')

    def check_evidence(evidence, owner):
        source = sources.get(evidence.get('source_id'))
        if not source:
            errors.append(f'{owner}: 引用来源不存在')
        elif source['content_status'] != 'relevant_body_read':
            errors.append(f'{owner}: 未读正文的来源不能支持已核对陈述')
        if not evidence.get('locator') or not evidence.get('object_form'):
            errors.append(f'{owner}: 缺原文定位或适用对象')

    for fact in facts:
        if not fact.get('evidence'):
            errors.append(f"{fact['id']}: 外部陈述缺证据")
        for evidence in fact.get('evidence', []):
            check_evidence(evidence, fact['id'])

    for material in data['materials']:
        if material['sample_smelling_status'] != 'not_performed':
            errors.append(f"{material['id']}: 本版没有实闻证据")
        for form in material['forms']:
            for tag in form['sensory_tags']:
                if tag['tag_id'] not in vocabulary:
                    errors.append(f"{form['id']}: 气味词不存在")
                check_evidence(tag['evidence'], form['id'])
                if tag['evidence']['object_form'] != form['object_form']:
                    errors.append(f"{form['id']}: 气味描述跨材料形态")

    for formula in data['historical_formulas']:
        source = sources.get(formula['source_id'])
        if not source or source['type'] != 'primary_historical_transcription':
            errors.append(f"{formula['id']}: 历史方缺对应历史正文来源")
        if not formula.get('locator'):
            errors.append(f"{formula['id']}: 缺具体条目定位")
        if formula['record_kind'] != 'historical_reference':
            errors.append(f"{formula['id']}: 历史身份被改变")
        if formula['production_approved'] or formula['manufacturing_recipe'] is not None:
            errors.append(f"{formula['id']}: 无审核证据却允许制作")
        if formula['historical_quantities'] is not None:
            errors.append(f"{formula['id']}: 本版没有采集完整数量数据")
        if formula['popularity_evidence']:
            errors.append(f"{formula['id']}: 本版没有受欢迎数据")

    for word in data['vocabulary']:
        if word['kind'] != 'project_authored_vocabulary':
            errors.append(f"{word['id']}: 自定义词被标为外部标准")
    for case in data['qa_cases']:
        for record_id in case.get('evidence_ids', []):
            if record_id not in fact_ids:
                errors.append(f"{case['id']}: 问答案例事实引用不存在")
        for record_id in case.get('rule_ids', []):
            if record_id not in rule_ids:
                errors.append(f"{case['id']}: 规则引用不存在")
        for record_id in case.get('historical_formula_ids', []):
            if record_id not in formula_ids:
                errors.append(f"{case['id']}: 历史方引用不存在")
    for key in ('modern_pairing_evidence', 'production_approved_formulas', 'design_presets'):
        if data[key]:
            errors.append(f'{key}: 本版尚未采集审核这些对象')
    return errors


def self_test(data):
    cases = []
    def reject(name, mutate):
        changed = copy.deepcopy(data)
        mutate(changed)
        passed = bool(validate(changed))
        cases.append({'case': name, 'expected': 'reject', 'passed': passed})
    reject('外部陈述缺证据', lambda d: d['materials'][0]['facts'][0].update(evidence=[]))
    reject('引用不存在的来源', lambda d: d['materials'][0]['facts'][0]['evidence'][0].update(source_id='missing'))
    reject('缺原文定位', lambda d: d['materials'][0]['facts'][0]['evidence'][0].update(locator=''))
    reject('把精油描述挂到木材', lambda d: d['materials'][1]['forms'][1].update(object_form='wood'))
    reject('历史方冒充可制作', lambda d: d['historical_formulas'][0].update(production_approved=True))
    reject('自定义词冒充标准', lambda d: d['vocabulary'][0].update(kind='industry_standard'))
    reject('正文未读却支持事实', lambda d: d['sources'][0].update(content_status='search_snippet_only'))
    reject('实闻状态无依据变更', lambda d: d['materials'][0].update(sample_smelling_status='verified'))
    return cases


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--output')
    args = parser.parse_args()
    path = Path(__file__).with_name('知识条目.json')
    data = json.loads(path.read_text())
    errors = validate(data)
    tests = self_test(data) if args.self_test else []
    result = {'date': data['updated_at'], 'errors': errors, 'structural_validation_passed': not errors,
              'rejection_tests': tests,
              'limitation': '只核对引用和明确边界；事实支持依赖本轮人工审读，未验证气味、配伍、制作或模型回答。'}
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(1 if errors or any(not t['passed'] for t in tests) else 0)

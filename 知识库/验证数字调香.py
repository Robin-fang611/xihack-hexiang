"""验证数字候选的约束和变化，不验证真实香气。"""
import copy
import json
import sys
from pathlib import Path
from 数字调香 import compose, demo, load_rules, normalize_facets, validate_rules


rules = load_rules()
checks = []
def check(name, condition):
    checks.append({'case': name, 'passed': bool(condition)})
def rejected(change):
    altered = copy.deepcopy(rules)
    change(altered)
    try:
        validate_rules(altered)
    except ValueError:
        return True
    return False

request = {'preferred_facets': ['woody'], 'deemphasized_facets': ['sweet'], 'locked_main_id': 'F01'}
result = compose(request, rules)
check('同输入同版本可复现', result == compose(request, rules))
excluded = compose({**request, 'excluded_ids': ['F02']}, rules)
check('硬排除优先', all(p['profile_id'] != 'F02' for c in excluded['candidates'] for p in c['components']))
check('固定主调被排除时报告冲突', compose({**request, 'excluded_ids': ['F01']}, rules)['status'] == 'constraint_conflict')
check('排除全部木质主调时不放松条件', compose({'excluded_ids': ['F01', 'F02']}, rules)['status'] == 'no_supported_main')
check('传统燃香请求不继承精油参照', compose({'mode': 'traditional_incense_burning'}, rules)['status'] == 'unsupported_domain')
check('未知标签不编造', compose({'preferred_facets': ['invented_smell']}, rules)['status'] == 'unknown_descriptors')
check('未知材料排除不静默忽略', compose({'excluded_ids': ['M01']}, rules)['status'] == 'unknown_exclusions')
check('跨形态原料拒绝进入该池', rejected(lambda r: r['profiles'][0].update(form='wood_powder')))
check('来源不存在时拒绝', rejected(lambda r: r['profiles'][0].update(source_id='missing')))
check('项目推测不能冒充厂家档案', rejected(lambda r: r['profiles'][0].update(profile_status='project_inference')))
check('通用教材不能支持材料标签', rejected(lambda r: r['profiles'][0].update(source_id='P01')))
for profile_id in ('F03', 'F04', 'F05'):
    locked_result = compose({'locked_main_id': profile_id}, rules)
    check(f'固定主调{profile_id}不被默认家族覆盖',
          locked_result['status'] == 'ok' and all(c['components'][0]['profile_id'] == profile_id
                                                for c in locked_result['candidates']))
check('显式家族与固定主调冲突时报告', compose({'locked_main_id': 'F04', 'main_family': 'woody'}, rules)['status'] == 'constraint_conflict')
example = demo()
before = example['before']['metrics_for_updated_intent']
after = example['after']['candidates']
check('调整后设计木质指标增加', all(c['metrics']['design_match_index'] > before['design_match_index'] for c in after))
check('调整后已报道甜香参照指标减少', all(c['metrics']['reported_deemphasized_facet_index'] < before['reported_deemphasized_facet_index'] for c in after))
check('主调保留且有明确变化', all(c['changes_from_start']['kept_main'] and c['changes_from_start']['removed'] for c in after))
keys = {tuple(sorted(p['profile_id'] for p in c['components'])) for c in after}
check('双候选有不同材料构成', len(after) == 2 and len(keys) == 2)
check('候选保留未验证状态', all(c['status'] == 'untested_composite_design' and not c['manufacturing_approved'] for c in after))
single = compose({'excluded_ids': ['F02', 'F03', 'F04', 'F05']}, rules)
check('单材结果不冒充复合结果', single['status'] == 'single_reference_only' and single['candidates'][0]['composition_kind'] == 'single_material_reference')
check('十个V编号独立映射到项目描述词', normalize_facets([f'V{i:02d}' for i in range(1, 11)], rules) ==
      ['woody', 'resinous', 'herbal', 'floral', 'fruity', 'citrus', 'spicy', 'sweet', 'earthy', 'smoky'])
translated = compose({'preferred_facets': ['木质'], 'deemphasized_facets': ['V08'], 'locked_main_id': 'F01'}, rules)
check('中文与V编号不改变原构图候选', translated['candidates'] == result['candidates'])
for descriptor in ('草本', 'V04', 'fruity'):
    check(f'未报道偏好{descriptor}明确未找到',
          compose({'preferred_facets': [descriptor]}, rules)['status'] == 'no_supported_preferences')
check('无明确目标不强行默认木质', compose({}, rules)['status'] == 'no_supported_main')
spicy = compose({'preferred_facets': ['V07']}, rules)
check('辛香偏好可选择辛香主调', spicy['status'] == 'ok' and
      all(c['components'][0]['profile_id'] == 'F05' for c in spicy['candidates']))
check('喜欢与减弱同词时报告冲突',
      compose({'preferred_facets': ['木质'], 'deemphasized_facets': ['V01']}, rules)['status'] == 'constraint_conflict')
output = {'date': rules['updated_at'], 'passed': all(c['passed'] for c in checks), 'checks': checks,
          'scope': '来源和资料域、排除、可复现及数字构图变化；无实物、剂量、配伍或感官预测验证。'}
if '--no-write' not in sys.argv:
    Path(__file__).with_name('数字调香核验结果.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'passed': output['passed'], 'checks': len(checks),
                  'failures': [c for c in checks if not c['passed']], 'scope': output['scope']}, ensure_ascii=False, indent=2))
raise SystemExit(0 if output['passed'] else 1)

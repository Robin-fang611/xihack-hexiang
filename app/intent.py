"""本机词表解释提案：只整理明确原话，不调用模型，也不应用用户条件。"""
from __future__ import annotations

import re


# 同义词用于解释用户用词，不给材料档案增加气味证据。
FACET_ALIASES = {
    'woody': ('木质香', '木香'),
    'sweet': ('甜感', '甜味', '香甜', '甜'),
    'smoky': ('烟熏', '烟味'),
    'resinous': ('树脂',),
    'creamy': ('奶油',),
    'earthy': ('泥土', '土壤'),
    'warm': ('温暖',),
    'leathery': ('皮革',),
    'amber': ('琥珀',),
    'vanilla': ('香草',),
    'peppery': ('胡椒',),
}
MATERIAL_ALIASES = {
    'F01': ('檀香', '澳洲檀香', '澳洲檀香精油'),
    'F02': ('雪松', '阿特拉斯雪松', '阿特拉斯雪松精油'),
    'F03': ('安息香', '暹罗安息香', '暹罗安息香乙醇提取物'),
    'F04': ('乳香', '乳香精油'),
    'F05': ('丁香', '丁香花蕾', '丁香花蕾精油'),
}

# 匹配明确意图，不以场景、健康期待或未收录意象猜测偏好。
PREFER = r'更喜欢|喜欢|想要|希望|保留|增加|多一些|多一点|多点|\b(?:more|prefer|like|want|keep)\b'
DEEMPHASIZE = (r'不太喜欢|不怎么喜欢|不那么喜欢|不喜欢|不太想要|不想要|不要|不想|不希望|'
              r'希望少|减少|减弱|少一些|少一点|少点|避开|不用|不使用|排除|讨厌|不爱|无|(?<!特)别|'
              r'\b(?:without|avoid|dislike|less|not\s+like|do\s+not\s+like|don[\'’]t\s+like|exclude|not|no)\b')
EXCLUDE = r'不要|不用|排除|避开|不想要|不使用|\b(?:without|avoid|exclude|no)\b'
CUE = re.compile(r'(?P<negative>' + DEEMPHASIZE + r')|(?P<positive>' + PREFER + r')', re.I)
EXCLUSION_CUE = re.compile(EXCLUDE, re.I)
AMBIGUOUS = re.compile(
    r'[？?]|吗|么|是否|是不是|会不会|要不要|该不该|能不能|不讨厌|不排斥|不反对|'
    r'并非不|不是不|不能不|不要不|不想不|不想不要|不喜欢不|不希望不|不但|不仅|'
    r'不要.{0,2}(?:少|减)|不确定|可能|也许|大概|好像|'
    r'\b(?:whether|should|could|unsure|maybe|perhaps|not\s+sure|'
    r'(?:not|do\s+not|don[\'’]t)\s+(?:dislike|avoid|not))\b', re.I)
CLAUSES = re.compile(r'[,，;；。!！\n]+|(?:但是|不过|然而|(?<!不)但)|\bbut\b', re.I)
GRAMMAR = re.compile(
    r'我们|我|自己|的|一些些|一点|一些|点|太|很|更|些|气味|香气|味道|感觉|方向|'
    r'希望|想要|想|要|喜欢|保留|增加|减少|减弱|不要|不用|排除|避开|讨厌|不爱|'
    r'和|及|与|也|还|或者|或|偏|比较|请|来|做|所有|有|多|少|'
    r'\b(?:i|we|a|an|the|and|or|please|some|a\s+bit|scent|fragrance|more|less|'
    r'prefer|like|want|keep|avoid|dislike|without|not|no|exclude)\b|[\s:：、/＋+()（）「」“”"\'-]', re.I)

# 否定不是“最近一个关键词”就能确定作用范围。未覆盖的否定或否定后的
# 第二层增减要求，整句留待用户表达，不能先生成相反条件再把“不”列为未知。
NEGATION = re.compile(
    r'不|没|未(?!来)|无|(?<!特)别|'
    r'(?<![A-Za-z0-9_])(?:not|no|never|without|don[\'’]t|doesn[\'’]t|didn[\'’]t|'
    r'cannot|can[\'’]t|won[\'’]t)(?![A-Za-z0-9_])', re.I)
DIRECTION = re.compile(
    r'少|多|減|减|降|增|增强|减弱|'
    r'\b(?:less|more|reduce|reducing|decrease|increase|weaken)\b', re.I)


def _term_pattern(term):
    escaped = re.escape(term)
    return r'(?<![A-Za-z0-9_])' + escaped + r'(?![A-Za-z0-9_])' if term.isascii() else escaped


def _dictionary(rules):
    terms = {}
    for facet, label in rules['facets'].items():
        for term in (facet, label, *FACET_ALIASES.get(facet, ())):
            terms[term] = ('facet', facet)
    for item in rules.get('vocabulary_bridge', []):
        terms[item['term']] = ('facet', item['canonical_facet'])
    for profile in rules['profiles']:
        for term in (profile['id'], *MATERIAL_ALIASES.get(profile['id'], ())):
            terms[term] = ('material', profile['id'])
    ordered = sorted(terms, key=lambda term: (-len(term), term))
    matcher = re.compile('|'.join(_term_pattern(term) for term in ordered), re.I)
    return {term.casefold(): target for term, target in terms.items()}, matcher


def _unclear_negation_scope(segment, hits):
    cues = list(CUE.finditer(segment))
    negative = [cue for cue in cues if cue.lastgroup == 'negative']
    for particle in NEGATION.finditer(segment):
        if not any(cue.start() <= particle.start() and cue.end() >= particle.end() for cue in negative):
            return True
    for cue in negative:
        if not NEGATION.search(cue.group()):
            continue
        # “不想减少木质”与“不希望多一些甜香”都否定了增减要求。
        # 已知词之间可有独立要求，先截到该否定后遇到的首个材料/气味词。
        target_start = next((hit.start() for hit in hits if hit.start() >= cue.end()), len(segment))
        following = segment[cue.end():target_start]
        previous = next((hit for hit in reversed(hits) if hit.end() <= cue.start()), None)
        if (previous is not None and not segment[previous.end():cue.start()].strip()
                and re.fullmatch(r'\s*(?:太|再|更)?多(?:一点|一些|点)?\s*', following)):
            # 已支持的单层后置要求：“木质不要太多 / 甜香别太多”。
            # “不要太少 / 不想减弱”仍保留为未知，不能反转为更喜欢。
            continue
        if CUE.search(following) or DIRECTION.search(following):
            return True
    return False


def _action(segment, hit, hits):
    """最近的明确前置词或紧接的后置数量词；不会把正向词当材料选择。"""
    cues = list(CUE.finditer(segment, 0, hit.start()))
    before = cues[-1] if cues else None
    next_start = next((other.start() for other in hits if other.start() > hit.start()), len(segment))
    after = segment[hit.end():next_start]
    suffix = re.match(r'^\s*(?:要|希望|想要)?\s*(?:再|更)?\s*'
                      r'(?P<direction>少一点|少一些|少点|减少|减弱|不要|不用|不使用|不喜欢|别|多一点|多一些|多点)', after)
    if suffix:
        return 'deemphasize' if not suffix['direction'].startswith('多') else 'prefer'
    if before:
        return 'deemphasize' if before.lastgroup == 'negative' else 'prefer'
    # 独立列出的已知气味词可以形成提案，修饰或叙述句没有明确意图则保留原话。
    remaining = segment
    for other in reversed(hits):
        remaining = remaining[:other.start()] + ' ' + remaining[other.end():]
    if re.fullmatch(r'(?:[\s、/＋+]|和|及|与|\band\b|\bor\b)*', remaining, re.I):
        return 'prefer'
    return None


def interpret(notes, rules, preferred, deemphasized, excluded):
    """所有入参由服务层核验。返回建议与依据，任何冲突都保留当前选项。"""
    dictionary, matcher = _dictionary(rules)
    recognized, unknown = [], []
    for raw in CLAUSES.split(notes):
        segment = raw.strip()
        if not segment:
            continue
        if AMBIGUOUS.search(segment):
            unknown.append(segment)
            continue
        hits = list(matcher.finditer(segment))
        if _unclear_negation_scope(segment, hits):
            unknown.append(segment)
            continue
        consumed = []
        for hit in hits:
            kind, target = dictionary[hit.group().casefold()]
            action = _action(segment, hit, hits)
            if kind == 'material':
                # “喜欢檀香”不等于选择或锁定檀香；材料排除也不能自动解除。
                before = segment[:hit.start()]
                after = segment[hit.end():]
                if action != 'deemphasize' or not (EXCLUSION_CUE.search(before) or
                    re.match(r'^\s*(?:不要|不用|不使用|排除|避开)', after)):
                    continue
                action = 'exclude'
            if not action:
                continue
            row = {'text': segment, 'facet': target if kind == 'facet' else None,
                   'action': action, 'basis': 'explicit_user_expression'}
            if kind == 'material':
                row['profile_id'] = target
            if not any(existing == row for existing in recognized):
                recognized.append(row)
            consumed.append((hit.start(), hit.end()))
        if not consumed:
            unknown.append(segment)
            continue
        remainder = segment
        for start, end in reversed(consumed):
            remainder = remainder[:start] + ' ' + remainder[end:]
        # 残留的场景、功效与意象仍展示给用户，不隐式变成材料条件。
        remainder = CUE.sub('', remainder)
        remainder = GRAMMAR.sub('', remainder).strip()
        if remainder:
            unknown.append(remainder)

    current = {'preferred_facets': list(preferred), 'deemphasized_facets': list(deemphasized),
               'excluded_ids': list(excluded)}
    proposal = {key: list(values) for key, values in current.items()}
    conflicts = []
    by_facet = {}
    for row in recognized:
        if row['facet']:
            by_facet.setdefault(row['facet'], []).append(row)
        elif row.get('profile_id') not in proposal['excluded_ids']:
            proposal['excluded_ids'].append(row['profile_id'])
    for facet, rows in by_facet.items():
        actions = {row['action'] for row in rows}
        texts = list(dict.fromkeys(row['text'] for row in rows))
        if len(actions) > 1:
            conflicts.append({'kind': 'text_contradiction', 'facet': facet, 'texts': texts,
                              'reason': f'原话同时提出保留和减弱“{rules["facets"][facet]}”，当前条件先保持。'})
            continue
        action = rows[0]['action']
        opposite = current['deemphasized_facets' if action == 'prefer' else 'preferred_facets']
        if facet in opposite:
            conflicts.append({'kind': 'manual_text_conflict', 'facet': facet, 'texts': texts,
                              'reason': f'原话与当前“{rules["facets"][facet]}”方向相反，当前条件先保持。'})
            continue
        key = 'preferred_facets' if action == 'prefer' else 'deemphasized_facets'
        if facet not in proposal[key]:
            proposal[key].append(facet)
    changed = proposal != current
    return {'status': 'needs_confirmation' if conflicts else 'proposal' if changed else 'no_changes',
            'proposal': proposal, 'recognized': recognized,
            'unknown_segments': list(dict.fromkeys(unknown)), 'conflicts': conflicts,
            'analysis_method': '本机词表与明确意图规则；未调用外部模型',
            'applied': False,
            'scope': '将用户明确原话整理为待应用条件；不判断实际气味、功效或制造兼容。'}

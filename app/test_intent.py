"""原话整理的行为验收；直接使用实际规则与构图服务，无数据库或外部模型。"""
import copy
import unittest

import services


class IntentTest(unittest.TestCase):
    def interpret(self, text, preferred=(), deemphasized=(), excluded=()):
        return services.interpret_preferences({
            'user_notes': text, 'manual_preferred': list(preferred),
            'manual_deemphasized': list(deemphasized), 'excluded_ids': list(excluded),
        })

    def test_opposite_words_change_actual_composition(self):
        wood = self.interpret('喜欢木质，甜香少一点')
        sweet = self.interpret('喜欢甜香，木质少一点')
        self.assertEqual(wood['proposal']['preferred_facets'], ['woody'])
        self.assertEqual(wood['proposal']['deemphasized_facets'], ['sweet'])
        self.assertEqual(sweet['proposal']['preferred_facets'], ['sweet'])
        self.assertEqual(sweet['proposal']['deemphasized_facets'], ['woody'])
        first = services.compose_design({**wood['proposal'], 'limit': 2})
        second = services.compose_design({**sweet['proposal'], 'limit': 2})
        self.assertEqual(first['status'], 'ok')
        self.assertEqual(second['status'], 'ok')
        signature = lambda result: [[(part['profile_id'], part['role'])
                                     for part in candidate['components']]
                                    for candidate in result['candidates']]
        self.assertNotEqual(signature(first), signature(second))
        profiles = {p['id']: p for p in services.bootstrap_data()['profiles']}
        self.assertEqual(profiles[first['candidates'][0]['components'][0]['profile_id']]['primary_family'], 'woody')
        self.assertEqual(profiles[second['candidates'][0]['components'][0]['profile_id']]['primary_family'], 'balsamic')

    def test_current_conditions_are_preserved_until_explicit_application(self):
        payload = {'user_notes': '喜欢木质，不要太甜，排除丁香',
                   'manual_preferred': ['柑橘'], 'manual_deemphasized': ['烟熏'],
                   'excluded_ids': ['F01']}
        before = copy.deepcopy(payload)
        result = services.interpret_preferences(payload)
        self.assertEqual(payload, before)
        self.assertFalse(result['applied'])
        self.assertEqual(result['proposal'], {'preferred_facets': ['citrus', 'woody'],
                                            'deemphasized_facets': ['smoky', 'sweet'],
                                            'excluded_ids': ['F01', 'F05']})
        self.assertTrue(all(row['basis'] == 'explicit_user_expression' for row in result['recognized']))
        self.assertIn('本机', result['analysis_method'])
        self.assertIn('未调用外部模型', result['analysis_method'])

    def test_manual_or_preset_conflict_keeps_current_conditions(self):
        cases = [('不喜欢木质', ['woody'], [], 'deemphasize'),
                 ('喜欢甜香', [], ['sweet'], 'prefer')]
        for text, preferred, deemphasized, action in cases:
            with self.subTest(text=text):
                result = self.interpret(text, preferred, deemphasized)
                self.assertEqual(result['status'], 'needs_confirmation')
                self.assertEqual(result['proposal']['preferred_facets'], preferred)
                self.assertEqual(result['proposal']['deemphasized_facets'], deemphasized)
                self.assertEqual(result['conflicts'][0]['kind'], 'manual_text_conflict')
                self.assertEqual(result['recognized'][0]['action'], action)
                self.assertIn(text, result['conflicts'][0]['texts'])

    def test_contradictory_words_do_not_choose_the_last_clause(self):
        for text in ('喜欢木质，不喜欢木质', '不喜欢木质，但是喜欢木质'):
            result = self.interpret(text, excluded=['F02'])
            self.assertEqual(result['status'], 'needs_confirmation')
            self.assertEqual(result['proposal'], {'preferred_facets': [], 'deemphasized_facets': [],
                                                 'excluded_ids': ['F02']})
            self.assertEqual(result['conflicts'][0]['kind'], 'text_contradiction')
            self.assertEqual({row['action'] for row in result['recognized']}, {'prefer', 'deemphasize'})

    def test_questions_double_negatives_scenes_and_health_remain_unmapped(self):
        examples = ['木质好吗？', '不要木质吗', '不讨厌木质', '不是不喜欢甜香',
                    '不想不要木质', 'Should I like woody?', '想要助眠、书房、雨后清透',
                    '不但有木质', 'not dislike woody', "I don't dislike woody",
                    'Not sure about woody', '可能想要木质', '木质不要太少']
        for text in examples:
            with self.subTest(text=text):
                result = self.interpret(text, ['citrus'], [], ['F05'])
                self.assertEqual(result['status'], 'no_changes')
                self.assertEqual(result['proposal'], {'preferred_facets': ['citrus'],
                                                     'deemphasized_facets': [], 'excluded_ids': ['F05']})
                self.assertEqual(result['recognized'], [])
                self.assertTrue(result['unknown_segments'])

    def test_unknown_modifiers_are_retained_without_inventing_material_facets(self):
        text = '想要书房里清透的木质，喜欢能助眠的奶油感'
        result = self.interpret(text)
        self.assertEqual(result['proposal']['preferred_facets'], ['woody', 'creamy'])
        unknown = ' '.join(result['unknown_segments'])
        self.assertIn('书房', unknown)
        self.assertIn('清透', unknown)
        self.assertIn('助眠', unknown)
        self.assertNotIn('manufacturing_approved', result)
        self.assertNotIn('sensory_verified', result)
        partial = self.interpret('不但有木质，还想要甜香')
        self.assertEqual(partial['proposal']['preferred_facets'], ['sweet'])
        self.assertIn('不但有木质', partial['unknown_segments'])

    def test_exclusions_only_add_and_reach_actual_composition(self):
        result = self.interpret('喜欢木质，不要丁香和乳香', excluded=['F01'])
        self.assertEqual(result['proposal']['excluded_ids'], ['F01', 'F05', 'F04'])
        exclusions = [row for row in result['recognized'] if row['action'] == 'exclude']
        self.assertEqual([row['profile_id'] for row in exclusions], ['F05', 'F04'])
        self.assertTrue(all(row['facet'] is None for row in exclusions))
        composed = services.compose_design({**result['proposal'], 'limit': 2})
        self.assertTrue(composed['candidates'])
        for candidate in composed['candidates']:
            self.assertFalse({part['profile_id'] for part in candidate['components']} & {'F01', 'F04', 'F05'})
        blocked = self.interpret('喜欢辛香，排除丁香')
        self.assertEqual(services.compose_design(blocked['proposal'])['status'], 'no_supported_preferences')
        self.assertEqual(blocked['proposal']['excluded_ids'], ['F05'])

    def test_material_mentions_do_not_select_or_unlock_materials(self):
        result = self.interpret('喜欢檀香，取消丁香的排除，不要玫瑰木', excluded=['F05'])
        self.assertEqual(result['status'], 'no_changes')
        self.assertEqual(result['recognized'], [])
        self.assertEqual(result['proposal']['excluded_ids'], ['F05'])
        self.assertEqual(result['proposal']['preferred_facets'], [])
        self.assertEqual(len(result['unknown_segments']), 3)

    def test_english_words_and_negation_use_word_boundaries(self):
        result = self.interpret('I like woody, less sweet, avoid F05')
        self.assertEqual(result['proposal'], {'preferred_facets': ['woody'],
                                             'deemphasized_facets': ['sweet'], 'excluded_ids': ['F05']})
        result = self.interpret('notes: woody')
        self.assertEqual(result['status'], 'no_changes')
        self.assertEqual(result['recognized'], [])
        self.assertEqual(result['unknown_segments'], ['notes: woody'])
        self.assertEqual(self.interpret("I don't like woody")['proposal']['deemphasized_facets'], ['woody'])
        self.assertEqual(self.interpret('不太喜欢木质')['proposal']['deemphasized_facets'], ['woody'])
        self.assertEqual(self.interpret('not woody')['proposal']['deemphasized_facets'], ['woody'])
        self.assertEqual(self.interpret('喜欢木质和sweet')['proposal']['preferred_facets'], ['woody', 'sweet'])
        self.assertEqual(self.interpret('不要F05')['proposal']['excluded_ids'], ['F05'])
        self.assertEqual(self.interpret('丁香不用')['proposal']['excluded_ids'], ['F05'])
        self.assertEqual(self.interpret('木质不要太多')['proposal']['deemphasized_facets'], ['woody'])
        self.assertEqual(self.interpret('甜香别太多')['proposal']['deemphasized_facets'], ['sweet'])

    def test_already_applied_repeated_words_and_empty_notes_do_not_change(self):
        for text in ('', '喜欢木质，喜欢木质，不要丁香'):
            result = self.interpret(text, ['woody'], [], ['F05'])
            self.assertEqual(result['status'], 'no_changes')
            self.assertEqual(result['proposal'], {'preferred_facets': ['woody'],
                                                 'deemphasized_facets': [], 'excluded_ids': ['F05']})
        result = self.interpret('木质、辛香')
        self.assertEqual(result['proposal']['preferred_facets'], ['woody', 'spicy'])

    def test_supported_vocabulary_without_material_evidence_stays_unsupported(self):
        result = self.interpret('喜欢花香')
        self.assertEqual(result['proposal']['preferred_facets'], ['floral'])
        composed = services.compose_design(result['proposal'])
        self.assertEqual(composed['status'], 'no_supported_preferences')
        self.assertEqual(composed['candidates'], [])

    def test_invalid_payloads_do_not_silently_drop_or_truncate_input(self):
        cases = [None, [], '木质', {'user_notes': []}, {'user_notes': '字' * 12001},
                 {'manual_preferred': [1]}, {'manual_preferred': ['未知气味']},
                 {'manual_preferred': ['wood y']}, {'manual_deemphasized': {}},
                 {'manual_preferred': ['woody'], 'manual_deemphasized': ['woody']},
                 {'excluded_ids': 'F05'}, {'excluded_ids': ['F99']}]
        for payload in cases:
            with self.subTest(payload=type(payload).__name__):
                result = services.interpret_preferences(payload)
                self.assertEqual(result['status'], 'invalid_request')
                self.assertNotIn('proposal', result)

    def test_nested_or_unscoped_negation_preserves_entire_clause_and_current_composition(self):
        examples = [
            '想要不甜的木质', '想要不太甜的木质', '喜欢不怎么甜的木质',
            '希望没有甜香的柑橘', '想要不浓的辛香',
            '不想减少木质', '不想减弱木质', '不想降低木质', '不希望少木质',
            '不希望减少木质', '不希望多一些甜香', '不要减少木质',
            '不喜欢多一点木质', '不是不想减少木质', '不想不喜欢木质',
            '不要不排除丁香', '不不喜欢木质', '木质不要再减弱',
            "I don't want less woody", 'I do not want to reduce woody',
            "I don't want to dislike woody", "I don't want to avoid F05",
            'not less woody', 'not more sweet', 'not no sweet', 'never reduce woody',
        ]
        current = {'preferred_facets': ['citrus'], 'deemphasized_facets': ['spicy'], 'excluded_ids': ['F05']}
        baseline = services.compose_design({**current, 'limit': 2})
        for text in examples:
            with self.subTest(text=text):
                result = self.interpret(text, ['citrus'], ['spicy'], ['F05'])
                self.assertEqual(result['status'], 'no_changes')
                self.assertEqual(result['proposal'], current)
                self.assertEqual(result['recognized'], [])
                self.assertEqual(result['unknown_segments'], [text])
                composed = services.compose_design({**result['proposal'], 'limit': 2})
                self.assertEqual(composed['candidates'], baseline['candidates'])

    def test_known_single_negation_and_independent_clauses_remain_effective(self):
        for text in ('不喜欢木质', '不要木质', '不想要木质', '不太喜欢木质',
                     '不要太甜', "I don't like woody", 'not woody'):
            with self.subTest(text=text):
                result = self.interpret(text)
                self.assertTrue(result['proposal']['deemphasized_facets'])
                self.assertEqual(result['proposal']['preferred_facets'], [])
                self.assertEqual(result['unknown_segments'], [])
        for text in ('不要丁香', '不用丁香', '排除丁香', '避开丁香', '不想要丁香'):
            with self.subTest(text=text):
                result = self.interpret(text, excluded=['F01'])
                self.assertEqual(result['proposal']['excluded_ids'], ['F01', 'F05'])
                self.assertEqual(result['recognized'][0]['action'], 'exclude')
        unlike_material = self.interpret('不喜欢丁香', excluded=['F01'])
        self.assertEqual(unlike_material['proposal']['excluded_ids'], ['F01'])
        self.assertEqual(unlike_material['recognized'], [])
        self.assertEqual(unlike_material['unknown_segments'], ['不喜欢丁香'])
        mixed = self.interpret('想要不太甜的木质，喜欢柑橘')
        self.assertEqual(mixed['proposal']['preferred_facets'], ['citrus'])
        self.assertEqual(mixed['unknown_segments'], ['想要不太甜的木质'])
        mixed = self.interpret('不希望减少木质，但喜欢甜香')
        self.assertEqual(mixed['proposal']['preferred_facets'], ['sweet'])
        self.assertEqual(mixed['unknown_segments'], ['不希望减少木质'])
        mixed = self.interpret('喜欢木质但不刺鼻')
        self.assertEqual(mixed['proposal']['preferred_facets'], ['woody'])
        self.assertEqual(mixed['unknown_segments'], ['不刺鼻'])
        self.assertEqual(self.interpret('希望减少甜香')['proposal']['deemphasized_facets'], ['sweet'])
        self.assertEqual(self.interpret('特别喜欢木质')['proposal']['preferred_facets'], ['woody'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

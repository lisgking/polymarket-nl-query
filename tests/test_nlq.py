#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线单测：python3 -m unittest discover -s tests -v （或 python3 tests/test_nlq.py）"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import nlq  # noqa: E402

NOW = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)


def b(intent, tz="Asia/Shanghai"):
    return nlq.build(intent, now=NOW, tz_name=tz)


def params_of(intent, tz="Asia/Shanghai"):
    res = b(intent, tz)
    assert res["ok"], res["errors"]
    return res["params"]


class AmountTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(nlq.parse_amount(250000), 250000)
        self.assertEqual(nlq.parse_amount("250000"), 250000)

    def test_chinese(self):
        self.assertEqual(nlq.parse_amount("100万"), 1_000_000)
        self.assertEqual(nlq.parse_amount("1.5万"), 15_000)
        self.assertEqual(nlq.parse_amount("2亿"), 200_000_000)
        self.assertEqual(nlq.parse_amount("100万美元"), 1_000_000)
        self.assertEqual(nlq.parse_amount("50萬"), 500_000)

    def test_short(self):
        self.assertEqual(nlq.parse_amount("$1.5M"), 1_500_000)
        self.assertEqual(nlq.parse_amount("10w"), 100_000)
        self.assertEqual(nlq.parse_amount("5K"), 5_000)
        self.assertEqual(nlq.parse_amount("2b"), 2_000_000_000)

    def test_invalid(self):
        for bad in ("很多", "", "1M2", True):
            with self.assertRaises(ValueError):
                nlq.parse_amount(bad)


class TimeTest(unittest.TestCase):
    def r(self, expr, tz="Asia/Shanghai"):
        return nlq.resolve_time(expr, NOW, nlq._get_tz(tz))

    def test_rel(self):
        self.assertEqual(self.r("rel:-7d"), "2026-11-03T12:00:00Z")
        self.assertEqual(self.r("rel:+3h"), "2026-11-10T15:00:00Z")
        self.assertEqual(self.r("rel:-2mo"), "2026-09-11T12:00:00Z")
        self.assertEqual(self.r("rel:+1y"), "2027-11-10T12:00:00Z")
        self.assertEqual(self.r("rel:-30min"), "2026-11-10T11:30:00Z")

    def test_tokens_use_local_tz(self):
        # NOW = 2026-11-10 20:00 Asia/Shanghai
        self.assertEqual(self.r("today_start"), "2026-11-09T16:00:00Z")
        self.assertEqual(self.r("today_end"), "2026-11-10T15:59:59Z")
        self.assertEqual(self.r("tomorrow_start"), "2026-11-10T16:00:00Z")
        self.assertEqual(self.r("week_start"), "2026-11-08T16:00:00Z")
        self.assertEqual(self.r("month_start"), "2026-10-31T16:00:00Z")
        self.assertEqual(self.r("month_end"), "2026-11-30T15:59:59Z")
        self.assertEqual(self.r("year_end"), "2026-12-31T15:59:59Z")

    def test_iso_passthrough(self):
        self.assertEqual(self.r("2026-11-01"), "2026-10-31T16:00:00Z")
        self.assertEqual(self.r("2026-11-01T00:00:00Z"), "2026-11-01T00:00:00Z")
        self.assertEqual(self.r("2026-11-01T08:00:00+08:00"), "2026-11-01T00:00:00Z")

    def test_tz_matters(self):
        self.assertEqual(self.r("today_start", "UTC"), "2026-11-10T00:00:00Z")

    def test_bad(self):
        with self.assertRaises(ValueError):
            self.r("下周三")
        with self.assertRaises(ValueError):
            self.r("rel:7x")


class BuildTest(unittest.TestCase):
    def test_keyword_and_state(self):
        p = params_of({"keyword": "OpenAI", "closed": False})
        self.assertEqual(p["title_search"], "OpenAI")
        self.assertIs(p["closed"], False)

    def test_closed_any(self):
        self.assertEqual(params_of({"closed": "any"})["closed"], "any")

    def test_tags_single_known_slug_uses_id(self):
        self.assertEqual(params_of({"tags": ["politics"]})["tag_id"], [2])

    def test_tags_single_unknown_slug_uses_tag_slug(self):
        self.assertEqual(params_of({"tags": ["sports"]})["tag_slug"], "sports")

    def test_tags_multi_known(self):
        p = params_of({"tags": ["politics", "elections"]})
        self.assertEqual(sorted(p["tag_id"]), [2, 144])

    def test_tags_multi_unknown_errors(self):
        res = b({"tags": ["sports", "crypto"]})
        self.assertFalse(res["ok"])
        self.assertIn("没有已知 id", res["errors"][0])

    def test_exclude_tags(self):
        p = params_of({"tags": ["politics"], "exclude_tags": ["elections"]})
        self.assertEqual(p["tag_id"], [2])
        self.assertEqual(p["exclude_tag_id"], [144])

    def test_volume_range(self):
        p = params_of({"volume": {"min": "10万", "max": "100万"}})
        self.assertEqual(p["volume_min"], 100_000)
        self.assertEqual(p["volume_max"], 1_000_000)

    def test_volume_bad_key(self):
        with self.assertRaises(ValueError):
            b({"volume": {"gte": 100}})

    def test_order_dict(self):
        p = params_of({"order": {"field": "endDate", "direction": "desc"}})
        self.assertEqual(p["order"], "endDate")
        self.assertIs(p["ascending"], False)

    def test_order_shortcut(self):
        p = params_of({"order": "volume", "ascending": False})
        self.assertEqual((p["order"], p["ascending"]), ("volume", False))

    def test_limit_clamped_with_warning(self):
        res = b({"limit": 500})
        self.assertEqual(res["params"]["limit"], 100)
        self.assertTrue(any("截断" in w for w in res["warnings"]))

    def test_unknown_slot_rejected(self):
        with self.assertRaises(ValueError):
            b({"query": "找体育盘"})

    def test_raw_param_passthrough(self):
        p = params_of({"series_id": [12], "include_children": True, "parent_event_id": 3})
        self.assertEqual(p["series_id"], [12])
        self.assertIs(p["include_children"], True)
        self.assertEqual(p["parent_event_id"], 3)

    def test_after_cursor(self):
        p = params_of({"after_cursor": "abcDEF_123"})
        self.assertEqual(p["after_cursor"], "abcDEF_123")

    def test_url_and_summary(self):
        res = b({"keyword": "OpenAI", "closed": False, "volume": {"min": "100万"},
                 "order": "volume", "ascending": False, "limit": 20})
        self.assertTrue(res["url"].startswith("https://gamma-api.polymarket.com/events/keyset?"))
        self.assertIn("title_search=OpenAI", res["query"])
        self.assertIn("未结算", res["summary"])

    def test_utf8_keyword_encoded(self):
        res = b({"keyword": "特朗普"})
        self.assertIn("%E7%89%B9", res["url"])
        self.assertIn("特朗普", res["summary"])


class CheckTest(unittest.TestCase):
    def c(self, raw, tz="Asia/Shanghai"):
        return nlq.check_params(raw, now=NOW, tz=nlq._get_tz(tz))

    def test_offset_rejected(self):
        with self.assertRaises(ValueError):
            self.c({"offset": 0})

    def test_unknown_param_rejected(self):
        with self.assertRaises(ValueError):
            self.c({"volume24hr_min": 1000})

    def test_tag_overlap_rejected(self):
        with self.assertRaises(ValueError):
            self.c({"tag_id": [2], "exclude_tag_id": [2]})

    def test_closed_bool_coercion(self):
        self.assertIs(self.c({"closed": "false"})[0]["closed"], False)

    def test_array_repeats_in_query(self):
        res = b({"tag_ids": [2, 144], "id": [1, 2]})
        self.assertIn("tag_id=2&tag_id=144", res["query"])
        self.assertIn("id=1&id=2", res["query"])

    def test_ascending_without_order_warns(self):
        _, w = self.c({"ascending": False})
        self.assertTrue(any("ascending" in x for x in w))

    def test_order_unknown_field_warns(self):
        _, w = self.c({"order": "banana"})
        self.assertTrue(any("banana" in x for x in w))

    def test_inverted_range_warns(self):
        _, w = self.c({"volume_min": 10, "volume_max": 5})
        self.assertTrue(any("volume_min" in x for x in w))

    def test_datetime_normalized(self):
        p, _ = self.c({"end_date_max": "2026-11-17T12:00:00+08:00"})
        self.assertEqual(p["end_date_max"], "2026-11-17T04:00:00Z")

    def test_limit_zero_rejected(self):
        p, w = self.c({"limit": 0})
        self.assertEqual(p["limit"], 1)
        self.assertTrue(w)


class SchemaTest(unittest.TestCase):
    def test_every_param_has_kind(self):
        for name, spec in nlq.PARAM_SPEC.items():
            self.assertIn("kind", spec, name)

    def test_slots_cover_managed(self):
        for slot in nlq.MANAGED:
            self.assertIn(slot, nlq.SLOT_KEYS, slot)


if __name__ == "__main__":
    unittest.main(verbosity=2)

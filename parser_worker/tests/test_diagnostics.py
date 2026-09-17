from __future__ import annotations

import unittest

from parser_worker.diagnostics import format_report


class DiagnosticsTests(unittest.TestCase):
    def test_format_report_is_safe_for_legacy_windows_console_encoding(self):
        rendered = format_report({"message": "Нужен сайт ✌"})

        self.assertIn('\\u270c', rendered)
        self.assertNotIn('✌', rendered)
        self.assertEqual({"message": "Нужен сайт ✌"}, __import__("json").loads(rendered))

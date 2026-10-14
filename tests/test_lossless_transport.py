import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "exchange_mail_bridge"))
import exchange_to_apps_script as bridge


def item(html="", raw=""):
    return SimpleNamespace(id="synthetic-id", subject="Synthetic test", body=html,
                           text_body=raw, attachments=[], has_attachments=False)


def serialize(message, include_html=True):
    return bridge.serialize_item(message, False, include_html, 2500000, 200000)


class LosslessTransportTests(unittest.TestCase):
    def test_html_beyond_legacy_limit_preserved(self):
        html = "<html>" + "x" * 220000 + "<p>TAIL-PFLICHT</p></html>"
        result = serialize(item(html))
        self.assertEqual(result["bodyHtml"], html)
        self.assertTrue(result["bodyHtml"].endswith("</html>"))

    def test_text_beyond_sheet_limit_preserved(self):
        raw = "x" * 60000 + "\nTAIL-PFLICHT"
        result = serialize(item(raw=raw))
        self.assertEqual(result["bodyTextRaw"], raw)
        self.assertEqual(result["bodyTextFull"], raw)
        self.assertLessEqual(len(result["bodyPreview"]), 1000)

    def test_raw_plaintext_survives_html_preference(self):
        raw = "Bewachung\r\nMedizinische Versorgung\x00\t"
        result = serialize(item("<p>Bewachung</p><p>Footer</p><p>Kontakt</p>", raw))
        self.assertEqual(result["bodyTextRaw"], raw)
        self.assertNotIn("Medizinische", result["bodyTextFull"])

    def test_unicode_utf8_utf16_and_json_roundtrip(self):
        html = "<p>Universität 🛡\r\n\x00 &amp;</p>"
        result = serialize(item(html, "Prüfung 🛡\r\n\x00"))
        self.assertEqual(json.loads(json.dumps(result)), result)
        for name in ("bodyHtml", "bodyTextRaw", "bodyTextFull"):
            text = result[name]
            expected = result["bodyIntegrity"][name]
            self.assertEqual(expected["sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
            self.assertEqual(expected["utf8Bytes"], len(text.encode("utf-8")))
            self.assertEqual(expected["utf16Length"], len(text.encode("utf-16-le")) // 2)

    def test_original_plain_body_fallback(self):
        raw = "  Original\r\nText\x00  "
        result = serialize(item(raw))
        self.assertEqual(result["bodyHtml"], "")
        self.assertEqual(result["bodyTextRaw"], raw)

    def test_empty_parts_have_verifiable_hashes(self):
        result = serialize(item())
        self.assertEqual(result["bodyIntegrity"]["version"], 2)
        self.assertEqual(result["bodyIntegrity"]["bodyHtml"]["sha256"], hashlib.sha256(b"").hexdigest())

    def test_html_disabled_rejects_instead_of_claiming_complete(self):
        with self.assertRaisesRegex(ValueError, "requires INCLUDE_BODY_HTML"):
            serialize(item("<p>Actual HTML</p>"), include_html=False)

    def test_oversize_source_rejects_instead_of_truncating(self):
        with patch.object(bridge, "MAX_BODY_SOURCE_BYTES", 20):
            with self.assertRaisesRegex(ValueError, "nothing was truncated"):
                serialize(item("<p>" + "x" * 30 + "</p>"))

    def test_batches_bound_json_size_without_dropping_messages(self):
        messages = [{"id": str(i), "value": "🛡" * 10} for i in range(4)]
        with patch.object(bridge, "MAX_POST_PAYLOAD_BYTES", 220):
            batches = list(bridge.iter_lossless_batches(messages, 10, "synthetic-token"))
        self.assertEqual([message for batch in batches for message in batch], messages)
        self.assertEqual(len(batches), 4)

    def test_individual_payload_too_large_rejected(self):
        with patch.object(bridge, "MAX_POST_PAYLOAD_BYTES", 50):
            with self.assertRaisesRegex(ValueError, "nothing was truncated"):
                list(bridge.iter_lossless_batches([{"value": "x" * 100}], 10, "synthetic-token"))

    def test_v2_requires_receiver_acknowledgement(self):
        message = serialize(item("<p>Body</p>"))
        with patch.dict(os.environ, {"BRIDGE_TOKEN": "synthetic-token"}), patch.object(bridge, "post_apps_script_batch", return_value={"ok": True}):
            with self.assertRaisesRegex(ValueError, "did not acknowledge"):
                bridge.post_messages([message])

    def test_acknowledged_v2_preserves_counter_result(self):
        message = serialize(item("<p>Body</p>"))
        with patch.dict(os.environ, {"BRIDGE_TOKEN": "synthetic-token"}), patch.object(bridge, "post_apps_script_batch", return_value={"ok": True, "protocolVersion": 2, "appended": 1}):
            self.assertEqual(bridge.post_messages([message])["appended"], 1)


if __name__ == "__main__":
    unittest.main()

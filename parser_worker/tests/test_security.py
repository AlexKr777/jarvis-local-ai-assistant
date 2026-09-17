import os
import tempfile
import unittest
from pathlib import Path

from parser_worker.security import DpapiSecretStore, redact_text


@unittest.skipUnless(os.name == "nt", "Windows DPAPI is required")
class DpapiSecretStoreTests(unittest.TestCase):
    def test_round_trip_uses_encrypted_bytes_and_supports_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DpapiSecretStore(Path(directory) / "secrets.db")
            store.set("telegram_session", "secret-session-value")

            raw = (Path(directory) / "secrets.db").read_bytes()
            self.assertNotIn(b"secret-session-value", raw)
            self.assertEqual(store.get("telegram_session"), "secret-session-value")
            store.delete("telegram_session")
            self.assertIsNone(store.get("telegram_session"))
            store.close()

    def test_redaction_covers_tokens_hashes_phone_and_passwords(self):
        visible = redact_text(
            "api_hash=abc bot_token=123:secret password=hunter2 phone=+37360000000 "
            "Authorization: Bearer key-value"
        )
        for secret in ["abc", "123:secret", "hunter2", "+37360000000", "key-value"]:
            self.assertNotIn(secret, visible)
        self.assertIn("[redacted]", visible)


if __name__ == "__main__":
    unittest.main()

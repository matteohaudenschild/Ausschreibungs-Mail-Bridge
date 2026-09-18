import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, call, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "exchange_mail_bridge"))

import exchange_to_apps_script as bridge  # noqa: E402


def response(status=200, body=None, url="https://script.google.com/macros/s/test/exec"):
    result = Mock()
    result.status_code = status
    result.url = url
    if body is None:
        body = {"ok": True, "appended": 0, "updated": 0, "skipped": 1}
    if isinstance(body, bytes):
        result.content = body
        result.json.side_effect = ValueError("not json")
    else:
        result.content = json.dumps(body).encode("utf-8")
        result.json.return_value = body
    return result


class AppsScriptRetryTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ,
            {
                "APPS_SCRIPT_WEBAPP_URL": "https://script.google.com/macros/s/test/exec",
                "APPS_SCRIPT_POST_ATTEMPTS": "6",
                "APPS_SCRIPT_CONNECT_TIMEOUT_SECONDS": "10",
                "APPS_SCRIPT_READ_TIMEOUT_SECONDS": "60",
                "APPS_SCRIPT_RETRY_BASE_DELAY_SECONDS": "5",
                "APPS_SCRIPT_RETRY_MAX_DELAY_SECONDS": "60",
                "APPS_SCRIPT_RETRY_JITTER_SECONDS": "0",
            },
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_google_redirect_404_can_recover_on_sixth_attempt(self):
        temporary = response(
            status=404,
            url="https://script.googleusercontent.com/macros/echo?redacted=1",
        )
        success = response()
        with patch.object(
            bridge.requests,
            "post",
            side_effect=[temporary, temporary, temporary, temporary, temporary, success],
        ) as request, patch.object(bridge.time, "sleep") as sleep, redirect_stdout(io.StringIO()):
            result = bridge.post_apps_script_batch({"messages": []})

        self.assertTrue(result["ok"])
        self.assertEqual(request.call_count, 6)
        self.assertEqual(
            sleep.call_args_list,
            [call(5.0), call(10.0), call(20.0), call(40.0), call(60.0)],
        )

    def test_timeout_retries_without_unbound_local_error(self):
        with patch.object(
            bridge.requests,
            "post",
            side_effect=[bridge.requests.ReadTimeout("temporary"), response()],
        ) as request, patch.object(bridge.time, "sleep") as sleep, redirect_stdout(io.StringIO()):
            result = bridge.post_apps_script_batch({"messages": []})

        self.assertTrue(result["ok"])
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(5.0)

    def test_non_json_success_response_is_retried(self):
        html = response(status=200, body=b"<html>temporary Google page</html>")
        with patch.object(
            bridge.requests,
            "post",
            side_effect=[html, response()],
        ) as request, patch.object(bridge.time, "sleep"), redirect_stdout(io.StringIO()):
            result = bridge.post_apps_script_batch({"messages": []})

        self.assertTrue(result["ok"])
        self.assertEqual(request.call_count, 2)

    def test_embedded_server_error_is_retried(self):
        apps_script_error = response(
            status=200,
            body={"ok": False, "error": "temporary sheet error", "statusCode": 500},
        )
        with patch.object(
            bridge.requests,
            "post",
            side_effect=[apps_script_error, response()],
        ) as request, patch.object(bridge.time, "sleep") as sleep, redirect_stdout(io.StringIO()):
            result = bridge.post_apps_script_batch({"messages": []})

        self.assertTrue(result["ok"])
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(5.0)

    def test_embedded_auth_error_is_not_retried(self):
        apps_script_error = response(
            status=200,
            body={"ok": False, "error": "Unauthorized.", "statusCode": 401},
        )
        with patch.object(
            bridge.requests,
            "post",
            return_value=apps_script_error,
        ) as request:
            result = bridge.post_apps_script_batch({"messages": []})

        self.assertFalse(result["ok"])
        self.assertEqual(result["statusCode"], 401)
        request.assert_called_once()

    def test_unrelated_404_is_not_retried(self):
        hard_404 = response(status=404, url="https://example.com/not-found")
        with patch.object(bridge.requests, "post", return_value=hard_404) as request:
            with self.assertRaisesRegex(RuntimeError, "non-retryable HTTP 404"):
                bridge.post_apps_script_batch({"messages": []})

        request.assert_called_once()

    def test_retry_log_does_not_include_url_query(self):
        temporary = response(
            status=404,
            url="https://script.googleusercontent.com/macros/echo?secret=value",
        )
        with patch.object(
            bridge.requests,
            "post",
            side_effect=[temporary, response()],
        ), patch.object(bridge.time, "sleep"), redirect_stdout(io.StringIO()) as output:
            bridge.post_apps_script_batch({"messages": []})

        log = output.getvalue()
        self.assertIn('"finalHost": "script.googleusercontent.com"', log)
        self.assertNotIn("secret=value", log)


if __name__ == "__main__":
    unittest.main()

import argparse
import base64
import json
import math
import os
import random
import re
import time
from datetime import timedelta
from html import unescape
from typing import Any, Callable, Dict, Iterable, List, TypeVar
from urllib.parse import urlsplit

import requests
from exchangelib import (
    BASIC,
    DELEGATE,
    FileAttachment,
    NTLM,
    Account,
    Configuration,
    Credentials,
    EWSDateTime,
    FaultTolerance,
    UTC,
)
from exchangelib.protocol import BaseProtocol, NoVerifyHTTPAdapter


DEFAULT_EWS_URL = "https://mail.wackerhagengruppe.de/EWS/Exchange.asmx"
T = TypeVar("T")


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip()


def required_env(name: str) -> str:
    value = env(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def parse_bool(value: str, default: bool = True) -> bool:
    if not value:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def parse_int_env(name: str, default: int, minimum: int = 0) -> int:
    value = env(name)
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(minimum, parsed)


def parse_float_env(name: str, default: float, minimum: float = 0.0) -> float:
    value = env(name)
    if not value:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    if not math.isfinite(parsed):
        return default
    return max(minimum, parsed)


def auth_type_from_env() -> str:
    auth_type = env("EWS_AUTH_TYPE", "NTLM").upper()
    if auth_type == "BASIC":
        return BASIC
    if auth_type == "NTLM":
        return NTLM
    raise SystemExit("EWS_AUTH_TYPE must be NTLM or BASIC")


def connect_account() -> Account:
    if not parse_bool(env("EWS_VERIFY_TLS"), default=True):
        BaseProtocol.HTTP_ADAPTER_CLS = NoVerifyHTTPAdapter

    credentials = Credentials(
        username=required_env("EWS_USERNAME"),
        password=required_env("EWS_PASSWORD"),
    )
    config = Configuration(
        service_endpoint=env("EWS_URL", DEFAULT_EWS_URL),
        credentials=credentials,
        auth_type=auth_type_from_env(),
        retry_policy=FaultTolerance(max_wait=60),
    )

    return Account(
        primary_smtp_address=required_env("EWS_EMAIL"),
        config=config,
        autodiscover=False,
        access_type=DELEGATE,
    )


def fetch_messages(account: Account, lookback_minutes: int, top: int) -> List[Dict[str, Any]]:
    cutoff = EWSDateTime.now(tz=UTC) - timedelta(minutes=lookback_minutes)
    include_attachments = parse_bool(env("INCLUDE_ATTACHMENTS"), default=False)
    include_body_html = parse_bool(env("INCLUDE_BODY_HTML"), default=True)
    max_attachment_bytes = int(env("MAX_ATTACHMENT_BYTES", "2500000"))
    max_body_html_chars = int(env("MAX_BODY_HTML_CHARS", "200000"))
    items = (
        account.inbox.filter(datetime_received__gte=cutoff)
        .order_by("-datetime_received")[:top]
    )
    return [
        serialize_item(
            item,
            include_attachments=include_attachments,
            include_body_html=include_body_html,
            max_attachment_bytes=max_attachment_bytes,
            max_body_html_chars=max_body_html_chars,
        )
        for item in items
    ]


def retry_transient_exchange(operation: Callable[[], T], stage: str) -> T:
    attempts = parse_int_env("EWS_FETCH_RETRIES", 4, minimum=1)
    delay_seconds = parse_int_env("EWS_FETCH_RETRY_DELAY_SECONDS", 20, minimum=0)

    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if not is_transient_exchange_error(exc) or attempt >= attempts:
                raise

            print(json.dumps({
                "ok": False,
                "stage": stage,
                "transient": True,
                "attempt": attempt,
                "attempts": attempts,
                "error": safe_error(exc),
                "note": "Temporary Exchange/EWS connection problem. Retrying.",
            }, ensure_ascii=False))
            if delay_seconds:
                time.sleep(delay_seconds)

    raise RuntimeError("unreachable retry state")


def is_transient_exchange_error(error: Exception) -> bool:
    text = safe_error(error).lower()
    transient_markers = [
        "connection reset by peer",
        "connection aborted",
        "remote end closed connection",
        "temporarily unavailable",
        "timeout",
        "timed out",
        "errortimeoutexpired",
        "transporterror",
        "serverbusy",
        "ssl",
    ]
    hard_auth_markers = [
        "unauthorized",
        "invalid credentials",
        "access is denied",
        "forbidden",
        "401",
        "403",
    ]
    return any(marker in text for marker in transient_markers) and not any(
        marker in text for marker in hard_auth_markers
    )


def safe_error(error: Exception) -> str:
    return f"{error.__class__.__name__}: {str(error)}"[:2000]


def serialize_item(
    item: Any,
    include_attachments: bool,
    include_body_html: bool,
    max_attachment_bytes: int,
    max_body_html_chars: int,
) -> Dict[str, Any]:
    sender = getattr(item, "sender", None) or getattr(item, "author", None)
    body_preview = extract_body_preview(item)
    body_html = extract_body_html(item, max_body_html_chars) if include_body_html else ""
    body_text_full = extract_body_text(item, limit=50000)
    body_links = extract_body_links(item)
    attachments = serialize_attachments(item, include_attachments, max_attachment_bytes)
    body_image_urls = extract_body_image_urls(item)
    attachment_count = count_attachments(item)

    return {
        "id": str(getattr(item, "id", "") or ""),
        "receivedTime": iso_or_empty(getattr(item, "datetime_received", None)),
        "fromName": str(getattr(sender, "name", "") or ""),
        "fromEmail": str(getattr(sender, "email_address", "") or ""),
        "subject": str(getattr(item, "subject", "") or ""),
        "bodyPreview": body_preview,
        "bodyTextFull": body_text_full,
        "bodyHtml": body_html,
        "bodyLinks": body_links,
        "hasAttachments": bool(getattr(item, "has_attachments", False) or attachments),
        "attachmentCount": attachment_count,
        "attachments": attachments,
        "bodyImageUrls": body_image_urls,
        "conversationId": str(getattr(item, "conversation_id", "") or ""),
        "webLink": "",
    }


def extract_body_preview(item: Any, limit: int = 1000) -> str:
    return extract_body_text(item, limit=limit)


def extract_body_text(item: Any, limit: int = 50000) -> str:
    text_body = getattr(item, "text_body", None)
    body = getattr(item, "body", None)
    html_text = html_to_text(str(body)) if body else ""

    if html_text and (
        not text_body
        or html_text.count("\n") > normalize_text_lines(str(text_body)).count("\n")
    ):
        return normalize_email_text_lines(html_text)[:limit]

    if text_body:
        return normalize_email_text_lines(str(text_body))[:limit]

    return ""


def extract_body_html(item: Any, limit: int) -> str:
    body = str(getattr(item, "body", "") or "")
    if not body:
        return ""
    if "<" not in body and ">" not in body:
        return ""
    return body[:limit]


def html_to_text(value: str) -> str:
    value = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value)
    value = re.sub(r"(?is)<img\b[^>]*>", image_tag_to_text, value)
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</?(?:p|div|tr|table|tbody|thead|tfoot|ul|ol|li|h[1-6])\b[^>]*>", "\n", value)
    value = re.sub(r"(?i)</?(?:td|th)\b[^>]*>", "\n", value)
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    return normalize_text_lines(unescape(value))


def image_tag_to_text(match: re.Match) -> str:
    attrs = extract_html_attributes(match.group(0))
    text = " ".join(
        value
        for value in (
            attrs.get("alt", ""),
            attrs.get("title", ""),
            attrs.get("aria-label", ""),
        )
        if value
    )
    return f"\n{text}\n" if text else " "


def normalize_email_text_lines(value: str) -> str:
    text = normalize_text_lines(unescape(value).replace("\u00a0", " "))
    if not looks_like_dtad_profile_mail(text):
        return text

    text = re.sub(
        r"(?i)\b(Suchprofilergebnisse?)\s+(\d{1,3})\s+",
        r"\1\n\2\n",
        text,
    )
    text = re.sub(
        r"(?i)\b(Zu allen\s+\d+\s+(?:Aufträgen|Auftraegen)\s+von\s+heute)\s+(\d{1,3})\s+",
        r"\1\n\2\n",
        text,
    )

    field_patterns = [
        r"Treffer bei\s*:",
        r"Kategorie\s+",
        r"Region\s*:",
        r"Frist\s*:",
        r"Projektstand\s*:",
        r"Vergabestelle\s*:",
        r"Auftraggeber\s*:",
        r"Weitere Informationen\s*:",
    ]
    for pattern in field_patterns:
        text = re.sub(rf"(?i)\s+({pattern})", r"\n\1", text)

    text = re.sub(r"\n{3,}", "\n\n", text)
    return normalize_text_lines(text)


def looks_like_dtad_profile_mail(value: str) -> bool:
    lowered = value.lower()
    return "suchprofilergebnis" in lowered or ("dtad" in lowered and "suchprofilergebnisse" in lowered)


def extract_body_links(item: Any, limit: int = 100) -> List[str]:
    body = str(getattr(item, "body", "") or "")
    if not body:
        return []

    links: List[str] = []
    for match in re.finditer(r"""(?is)<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)</a>""", body):
        href = normalize_text(unescape(match.group(1)))
        label = html_to_text(match.group(2))[:200]
        if not href:
            continue
        value = f"{label} | {href}" if label else href
        if value not in links:
            links.append(value[:4000])
        if len(links) >= limit:
            return links
    return links


def extract_body_image_urls(item: Any, limit: int = 20) -> List[str]:
    body = str(getattr(item, "body", "") or "")
    if not body:
        return []

    urls: List[str] = []
    for match in re.finditer(r"""(?is)<img\b[^>]*>""", body):
        attrs = extract_html_attributes(match.group(0))
        parts = []
        for key in ("src", "alt", "title", "aria-label", "class", "id", "width", "height"):
            value = attrs.get(key, "")
            if value:
                parts.append(f"{key}={value}")
        if parts:
            value = "IMG " + " | ".join(parts)
            if value not in urls:
                urls.append(value[:2000])
        if len(urls) >= limit:
            return urls

    patterns = [
        r"""(?is)<img\b[^>]*\bsrc=["']([^"']+)["']""",
        r"""(?is)\b(?:src|href|background)=["']([^"']+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^"']*)?)["']""",
        r"""(?is)url\(["']?([^)"']+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^)"']*)?)["']?\)""",
        r"""(?is)\b(cid:[^"' <>)]+)""",
        r"""(?is)\b(data:image/[^"' <>)]+)""",
    ]

    for pattern in patterns:
        for match in re.finditer(pattern, body):
            src = normalize_text(unescape(match.group(1)))
            if src and src not in urls:
                urls.append(src[:2000])
            if len(urls) >= limit:
                return urls
    return urls


def extract_html_attributes(tag: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for match in re.finditer(r"""(?is)([a-z0-9_-]+)\s*=\s*(["'])(.*?)\2""", tag):
        key = match.group(1).lower()
        value = normalize_text(unescape(match.group(3)))
        if value:
            attrs[key] = value
    return attrs


def count_attachments(item: Any) -> int:
    attachments = getattr(item, "attachments", None) or []
    try:
        return len(attachments)
    except TypeError:
        return 0


def serialize_attachments(item: Any, include_attachments: bool, max_attachment_bytes: int) -> List[Dict[str, Any]]:
    attachments = getattr(item, "attachments", None) or []
    if not include_attachments:
        return []

    serialized = []
    for attachment in attachments:
        if not isinstance(attachment, FileAttachment):
            continue

        name = str(getattr(attachment, "name", "") or "attachment")
        content_type = str(getattr(attachment, "content_type", "") or "application/octet-stream")
        is_inline = bool(getattr(attachment, "is_inline", False))
        content_id = str(getattr(attachment, "content_id", "") or "")

        if not should_download_attachment(name, content_type, is_inline):
            serialized.append(attachment_metadata(attachment, skipped_reason="unsupported_type"))
            continue

        content = getattr(attachment, "content", b"") or b""
        size = len(content)
        if size <= 0:
            serialized.append(attachment_metadata(attachment, skipped_reason="empty"))
            continue
        if size > max_attachment_bytes:
            serialized.append(attachment_metadata(attachment, skipped_reason="too_large"))
            continue

        serialized.append(
            {
                "name": name,
                "contentType": content_type,
                "size": size,
                "isInline": is_inline,
                "contentId": content_id,
                "base64": base64.b64encode(content).decode("ascii"),
            }
        )
    return serialized


def attachment_metadata(attachment: Any, skipped_reason: str) -> Dict[str, Any]:
    return {
        "name": str(getattr(attachment, "name", "") or "attachment"),
        "contentType": str(getattr(attachment, "content_type", "") or ""),
        "size": int(getattr(attachment, "size", 0) or 0),
        "isInline": bool(getattr(attachment, "is_inline", False)),
        "contentId": str(getattr(attachment, "content_id", "") or ""),
        "skippedReason": skipped_reason,
    }


def should_download_attachment(name: str, content_type: str, is_inline: bool) -> bool:
    allowed_prefixes = [
        prefix.strip().lower()
        for prefix in env("ATTACHMENT_MIME_PREFIXES", "image/").split(",")
        if prefix.strip()
    ]
    lowered_content_type = content_type.lower()
    if any(lowered_content_type.startswith(prefix) for prefix in allowed_prefixes):
        return True

    lowered_name = name.lower()
    image_extensions = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff")
    return is_inline and lowered_name.endswith(image_extensions)


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\x00", "")).strip()


def normalize_text_lines(value: str) -> str:
    lines = [
        re.sub(r"[ \t\f\v]+", " ", line).strip()
        for line in value.replace("\x00", "").splitlines()
    ]
    return "\n".join(line for line in lines if line)


def iso_or_empty(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def post_messages(messages: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    message_list = list(messages)
    batch_size = max(1, int(env("POST_BATCH_SIZE", "10")))
    result: Dict[str, Any] = {"ok": True, "appended": 0, "updated": 0, "skipped": 0}

    for index in range(0, len(message_list), batch_size):
        payload = {
            "token": required_env("BRIDGE_TOKEN"),
            "messages": message_list[index:index + batch_size],
        }
        batch_result = post_apps_script_batch(payload)
        if not batch_result.get("ok"):
            raise SystemExit("Apps Script returned an error response (ok=false).")

        for key in ("appended", "updated", "skipped"):
            result[key] += int(batch_result.get(key, 0) or 0)

    return result


def post_apps_script_batch(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Post an idempotent batch with bounded, selective retries.

    The receiving Apps Script deduplicates by Exchange message ID. Repeating the
    exact batch is therefore safe even if a response is lost after the sheet was
    already updated.
    """
    webapp_url = required_env("APPS_SCRIPT_WEBAPP_URL")
    legacy_attempts = parse_int_env("APPS_SCRIPT_POST_RETRIES", 6, minimum=1)
    attempts = parse_int_env("APPS_SCRIPT_POST_ATTEMPTS", legacy_attempts, minimum=1)
    legacy_delay = parse_float_env("APPS_SCRIPT_POST_RETRY_DELAY_SECONDS", 5.0, minimum=0.0)
    base_delay = parse_float_env("APPS_SCRIPT_RETRY_BASE_DELAY_SECONDS", legacy_delay, minimum=0.0)
    max_delay = parse_float_env("APPS_SCRIPT_RETRY_MAX_DELAY_SECONDS", 60.0, minimum=0.0)
    jitter = parse_float_env("APPS_SCRIPT_RETRY_JITTER_SECONDS", 1.0, minimum=0.0)
    legacy_timeout = parse_float_env("APPS_SCRIPT_TIMEOUT", 60.0, minimum=0.001)
    connect_timeout = parse_float_env(
        "APPS_SCRIPT_CONNECT_TIMEOUT_SECONDS", 10.0, minimum=0.001
    )
    read_timeout = parse_float_env(
        "APPS_SCRIPT_READ_TIMEOUT_SECONDS", legacy_timeout, minimum=0.001
    )

    for attempt in range(1, attempts + 1):
        try:
            response = requests.post(
                webapp_url,
                json=payload,
                timeout=(connect_timeout, read_timeout),
            )
        except (
            requests.Timeout,
            requests.ConnectionError,
            requests.exceptions.ChunkedEncodingError,
        ) as exc:
            if isinstance(exc, requests.Timeout):
                reason = "timeout"
            elif isinstance(exc, requests.exceptions.ChunkedEncodingError):
                reason = "response_interrupted"
            else:
                reason = "connection_error"
            if attempt < attempts:
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason=reason,
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                )
                continue
            raise RuntimeError(
                f"Apps Script request failed after {attempts} attempt(s): {reason}."
            ) from None
        except requests.RequestException:
            raise RuntimeError(
                "Apps Script request failed with a non-retryable transport error."
            ) from None

        status_code = int(response.status_code)
        final_host = response_final_host(response)
        if is_retryable_apps_script_status(status_code, final_host):
            if attempt < attempts:
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason="http_status",
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                    status_code=status_code,
                    final_host=final_host,
                )
                continue
            raise RuntimeError(
                f"Apps Script returned retryable HTTP {status_code} after "
                f"{attempts} attempt(s)."
            )

        if not 200 <= status_code < 300:
            raise RuntimeError(
                f"Apps Script returned non-retryable HTTP {status_code}."
            )

        if not (response.content or b"").strip():
            if attempt < attempts:
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason="empty_response",
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                    status_code=status_code,
                    final_host=final_host,
                )
                continue
            raise RuntimeError(
                f"Apps Script returned an empty response after {attempts} attempt(s)."
            )

        try:
            batch_result = response.json()
        except ValueError:
            if attempt < attempts:
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason="non_json_response",
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                    status_code=status_code,
                    final_host=final_host,
                )
                continue
            raise RuntimeError(
                f"Apps Script returned a non-JSON response after {attempts} attempt(s)."
            ) from None

        if not isinstance(batch_result, dict):
            if attempt < attempts:
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason="invalid_json_response",
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                    status_code=status_code,
                    final_host=final_host,
                )
                continue
            raise RuntimeError(
                f"Apps Script returned invalid JSON after {attempts} attempt(s)."
            )

        embedded_status = int(nonnegative_finite_number(
            batch_result.get("statusCode"), default=0.0
        ))
        response_is_transient = (
            batch_result.get("transient") is True
            or embedded_status in {408, 425, 429}
            or 500 <= embedded_status <= 599
        )
        if batch_result.get("ok") is False and response_is_transient:
            if attempt < attempts:
                retry_after = nonnegative_finite_number(
                    batch_result.get("retryAfterSeconds"), default=0.0
                )
                sleep_before_apps_script_retry(
                    attempt=attempt,
                    attempts=attempts,
                    reason="apps_script_transient_response",
                    base_delay=base_delay,
                    max_delay=max_delay,
                    jitter=jitter,
                    minimum_delay=retry_after,
                    status_code=embedded_status,
                    final_host=final_host,
                )
                continue

        return batch_result

    raise RuntimeError("unreachable Apps Script retry state")


def response_final_host(response: requests.Response) -> str:
    """Return only the final hostname, never a URL containing transient tokens."""
    try:
        return (urlsplit(str(response.url or "")).hostname or "").lower()
    except ValueError:
        return ""


def is_retryable_apps_script_status(status_code: int, final_host: str) -> bool:
    if status_code in {408, 425, 429} or 500 <= status_code <= 599:
        return True
    return status_code == 404 and final_host == "script.googleusercontent.com"


def nonnegative_finite_number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return max(0.0, parsed)


def sleep_before_apps_script_retry(
    *,
    attempt: int,
    attempts: int,
    reason: str,
    base_delay: float,
    max_delay: float,
    jitter: float,
    minimum_delay: float = 0.0,
    status_code: int = 0,
    final_host: str = "",
) -> None:
    delay = base_delay * (2 ** (attempt - 1))
    if jitter:
        delay += random.uniform(0.0, jitter)
    if max_delay:
        delay = min(delay, max_delay)
        minimum_delay = min(minimum_delay, max_delay)
    delay = max(delay, minimum_delay)

    log_entry: Dict[str, Any] = {
        "ok": False,
        "stage": "apps_script_post",
        "transient": True,
        "attempt": attempt,
        "attempts": attempts,
        "reason": reason,
        "retryInSeconds": round(delay, 3),
    }
    if status_code:
        log_entry["status"] = status_code
    if final_host:
        log_entry["finalHost"] = (
            final_host
            if final_host in {"script.google.com", "script.googleusercontent.com"}
            else "other"
        )

    print(json.dumps(log_entry, ensure_ascii=False))
    if delay:
        time.sleep(delay)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Poll Exchange EWS and push mail rows to Apps Script.")
    parser.add_argument("--dry-run", action="store_true", help="Print messages instead of posting to Apps Script.")
    parser.add_argument(
        "--dry-run-summary",
        action="store_true",
        help="Print a safe summary instead of posting to Apps Script. Does not include mail bodies or attachments.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    lookback_minutes = int(env("MAIL_LOOKBACK_MINUTES", "60"))
    top = int(env("MAIL_TOP", "25"))

    account = connect_account()
    try:
        messages = retry_transient_exchange(
            lambda: fetch_messages(account, lookback_minutes=lookback_minutes, top=top),
            stage="exchange_fetch",
        )
    except Exception as exc:
        if is_transient_exchange_error(exc) and parse_bool(env("EWS_TRANSIENT_FAILURE_EXIT_ZERO"), default=True):
            print(json.dumps({
                "ok": True,
                "skipped": True,
                "stage": "exchange_fetch",
                "reason": "transient_exchange_error",
                "error": safe_error(exc),
                "note": "Exchange/EWS was temporarily unavailable. This run is treated as skipped; the next scheduled run will retry.",
            }, ensure_ascii=False))
            return
        raise

    if args.dry_run_summary:
        print(json.dumps(build_dry_run_summary(messages), ensure_ascii=False, indent=2))
        return

    if args.dry_run:
        print(json.dumps({"messages": redact_attachment_payloads(messages)}, ensure_ascii=False, indent=2))
        return

    result = post_messages(messages)
    print(json.dumps(result, ensure_ascii=False))


def redact_attachment_payloads(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    redacted = json.loads(json.dumps(messages))
    for message in redacted:
        for attachment in message.get("attachments", []):
            if "base64" in attachment:
                attachment["base64"] = f"<{len(attachment['base64'])} base64 chars>"
    return redacted


def build_dry_run_summary(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "ok": True,
        "mode": "dry-run-summary",
        "messageCount": len(messages),
        "messages": [
            {
                "receivedTime": message.get("receivedTime", ""),
                "fromName": message.get("fromName", ""),
                "fromEmail": message.get("fromEmail", ""),
                "subject": message.get("subject", ""),
                "hasAttachments": bool(message.get("hasAttachments", False)),
                "attachmentCount": int(message.get("attachmentCount", 0) or 0),
                "bodyTextLength": len(str(message.get("bodyTextFull", "") or "")),
                "bodyHtmlLength": len(str(message.get("bodyHtml", "") or "")),
                "bodyLinkCount": len(message.get("bodyLinks", []) or []),
                "bodyImageUrlCount": len(message.get("bodyImageUrls", []) or []),
            }
            for message in messages
        ],
        "note": "NO SEND - no Apps Script post, no Sheet write, no email send.",
    }


if __name__ == "__main__":
    main()

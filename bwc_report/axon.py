"""Axon EvidenceCreated contracts, based on the supplied vendor documentation.

Pure request/response helpers for verification. Production acquisition remains a
Power Automate cloud flow; this module does not contact Axon or store tokens.
"""
from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from urllib.parse import urlencode, urlsplit

from .core import OPTIONAL, REQUIRED, ReportError, read_csv

API_REQUIRED = ("evidenceId", "status", "dateUploaded", "ownerGroups", "categories")
TEXT_MAPPING = {
    "Evidence ID": "evidenceId", "Status": "status", "Date Uploaded": "dateUploaded",
    "External Evidence ID": "idExternal", "Evidence Type": "evidenceType",
    "Owner Badge ID": "ownerBadgeId", "Owner First Name": "ownerFirstName",
    "Owner Last Name": "ownerLastName", "Owner Role": "ownerRole",
    "Serial Number": "serialNumber", "Created Date (Record Start)": "dateRecordStart",
}


def evidence_created_url(base_url: str, agency_id: str, from_date: date, to_date: date,
                         page_offset: int = 0, page_size: int = 50) -> str:
    parsed = urlsplit(base_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ReportError("Axon base URL must be an HTTPS agency origin without credentials or an API path.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agency_id):
        raise ReportError("Provide a valid agency/partner ID.")
    if (type(page_offset) is not int or page_offset < 0 or type(page_size) is not int
            or not 1 <= page_size <= 50 or to_date < from_date):
        raise ReportError("Invalid reporting date range, page offset, or page size (maximum 50).")
    query = urlencode({"reportType": "EvidenceCreated", "fromDate": from_date.isoformat(),
                       "toDate": to_date.isoformat(), "pageSize": page_size, "pageOffset": page_offset})
    return f"{base_url.rstrip('/')}/api/v1/agencies/{agency_id}/reports/data?{query}"


def token_form(client_id: str, client_secret: str, partner_id: str | None = None) -> bytes:
    """URL-encode every value. Do not log the returned body or credential values."""
    if not client_id or not client_secret:
        raise ReportError("Token acquisition requires configured client credentials.")
    fields = {"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret}
    if partner_id is not None:
        if not partner_id:
            raise ReportError("A configured legacy partner ID must not be empty.")
        fields["partner_id"] = partner_id
    return urlencode(fields).encode("ascii")


def evidence_updated_url(base_url: str, agency_id: str, from_datetime: datetime,
                         to_datetime: datetime, page_offset: int = 0, page_size: int = 50) -> str:
    if (from_datetime.tzinfo is None or to_datetime.tzinfo is None
            or to_datetime < from_datetime):
        raise ReportError("Updated reports require an ordered, timezone-aware timestamp window.")
    # Reuse the origin, agency and pagination validation from the Created resource.
    base = evidence_created_url(base_url, agency_id, date(2000, 1, 1), date(2000, 1, 1),
                                page_offset, page_size).split("?", 1)[0]
    query = urlencode({"reportType": "EvidenceUpdated",
                       "updatedFromDateTime": from_datetime.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
                       "updatedToDateTime": to_datetime.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
                       "pageSize": page_size, "pageOffset": page_offset})
    return f"{base}?{query}"


@dataclass(frozen=True)
class RetryPlan:
    action: str
    delay_seconds: int = 0


def retry_plan(status: int, retry_after: str | None = None, attempt: int = 0,
               token_request: bool = False, token_already_refreshed: bool = False,
               max_retries: int = 6) -> RetryPlan:
    if 200 <= status < 300:
        return RetryPlan("success")
    if attempt >= max_retries:
        return RetryPlan("fail")
    if status == 401 and not token_request and not token_already_refreshed:
        return RetryPlan("refresh-token")
    if status == 429:
        value = (retry_after or "").strip()
        return RetryPlan("retry", int(value) if re.fullmatch(r"\d+", value) else 300)
    if 500 <= status < 600:
        return RetryPlan("retry", min(2 ** max(0, attempt), 60))
    return RetryPlan("fail")


def _api_text(record: dict, key: str) -> str:
    value = record.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ReportError(f"API field {key} must be text or null; do not coerce identifier types.")
    return value.strip()


def _api_names(record: dict, key: str) -> list[str]:
    value = record[key]
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise ReportError(f"API field {key} must be an array of nonempty names or null.")
    return [item.strip() for item in value]


def normalize_record(record: dict, report_type: str = "EvidenceCreated") -> dict[str, str]:
    if report_type not in ("EvidenceCreated", "EvidenceUpdated"):
        raise ReportError("Unknown report type.")
    if not isinstance(record, dict) or any(key not in record for key in API_REQUIRED):
        raise ReportError("EvidenceCreated record is missing required API fields; do not publish partial metadata.")
    result = {key: "" for key in REQUIRED + OPTIONAL}
    for canonical, vendor in TEXT_MAPPING.items():
        result[canonical] = _api_text(record, vendor)
    groups = _api_names(record, "ownerGroups")
    if report_type == "EvidenceUpdated" and record["categories"] is not None:
        value = record["categories"]
        if not isinstance(value, list) or any(not isinstance(item, dict)
                or not isinstance(item.get("category"), str) or not item["category"].strip() for item in value):
            raise ReportError("EvidenceUpdated categories must contain category objects.")
        categories = [item["category"].strip() for item in value]
    elif report_type == "EvidenceCreated" or record["categories"] is None:
        categories = _api_names(record, "categories")
    else:
        raise ReportError("Unknown report type.")
    result["Owner Groups"] = ", ".join(groups)
    # Preserve explicit category presence even if a real category is named NULL/NA.
    result["Categories"] = json.dumps(categories, ensure_ascii=False) if categories else ""
    # The documented report has no evidence-serial field. idExternal is not a serial.
    return result


def normalize_page_bundle(bundle: object) -> list[dict[str, str]]:
    if (not isinstance(bundle, dict) or bundle.get("schema_version") != 1
            or bundle.get("report_type") != "EvidenceCreated"):
        raise ReportError("Expected an EvidenceCreated page bundle with schema_version 1.")
    try:
        if any(not isinstance(bundle.get(key), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", bundle[key])
               for key in ("from_date", "to_date")):
            raise ValueError("Invalid date format")
        start, end = (date.fromisoformat(bundle[key]) for key in ("from_date", "to_date"))
    except (KeyError, ValueError, TypeError) as exc:
        raise ReportError("Page bundle requires valid from_date and to_date.") from exc
    if end < start:
        raise ReportError("Page bundle has a reversed creation-date range.")
    if "sample_data" in bundle and type(bundle["sample_data"]) is not bool:
        raise ReportError("sample_data must be a boolean when provided.")
    size = bundle.get("page_size")
    pages = bundle.get("pages")
    if type(size) is not int or not 1 <= size <= 50 or not isinstance(pages, list) or not pages:
        raise ReportError("Page bundle requires page_size 1–50 and at least the terminal page.")
    records = []
    for index, page in enumerate(pages):
        if (not isinstance(page, dict) or type(page.get("page_offset")) is not int
                or page["page_offset"] != index or not isinstance(page.get("data"), list)):
            raise ReportError("Report pages must be contiguous from page_offset 0 and contain data arrays.")
        if len(page["data"]) > size:
            raise ReportError("Report page exceeds the configured page size.")
        if not page["data"]:
            if index != len(pages) - 1:
                raise ReportError("Empty terminal report page must be last.")
        elif index == len(pages) - 1:
            raise ReportError("Incomplete report: the final successful page must contain an empty data array.")
        records.extend(normalize_record(record) for record in page["data"])
    return records


def page_bundle_csv(bundle: object) -> bytes:
    text = io.StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=REQUIRED + OPTIONAL)
    writer.writeheader()
    writer.writerows(normalize_page_bundle(bundle))
    return text.getvalue().encode("utf-8-sig")


def read_page_bundle(content: bytes) -> list[dict[str, str]]:
    try:
        bundle = json.loads(content.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ReportError("Could not parse the API page bundle JSON.") from exc
    return read_csv(page_bundle_csv(bundle), null_markers=False)

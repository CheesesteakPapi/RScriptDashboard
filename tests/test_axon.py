import json
import unittest
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from bwc_report.axon import (evidence_created_url, evidence_updated_url, normalize_page_bundle, normalize_record,
                             read_page_bundle, retry_plan, token_form)
from bwc_report.core import ReportError, transform

DAY = date(2026, 10, 13)


def record(**changes):
    return {"evidenceId": "SYNTHETIC-INTERNAL-001", "idExternal": "SYNTHETIC-CASE-1",
            "status": "Active", "dateUploaded": "2026-09-13T08:00:00Z",
            "ownerGroups": ["HSI Baltimore Users", "Admin"], "categories": [],
            "ownerBadgeId": "0007", **changes}


def bundle(pages=None, **changes):
    return {"schema_version": 1, "report_type": "EvidenceCreated", "from_date": "2024-03-11",
            "to_date": "2026-10-13", "page_size": 50, "sample_data": True,
            "pages": pages if pages is not None else [
                {"page_offset": 0, "data": [record()]}, {"page_offset": 1, "data": []}], **changes}


class AxonContractTests(unittest.TestCase):
    def test_reporting_endpoint_and_page_index(self):
        url = evidence_created_url("https://agency.example.invalid", "SYNTHETIC-AGENCY",
                                  date(2024, 3, 11), DAY, page_offset=1)
        parts = urlsplit(url)
        self.assertEqual(parts.path, "/api/v1/agencies/SYNTHETIC-AGENCY/reports/data")
        self.assertEqual(parse_qs(parts.query), {"reportType": ["EvidenceCreated"],
            "fromDate": ["2024-03-11"], "toDate": ["2026-10-13"], "pageSize": ["50"], "pageOffset": ["1"]})

    def test_invalid_origin_and_reporting_parameters(self):
        for host in ("http://agency.example.invalid", "https://user:password@agency.example.invalid",
                     "https://agency.example.invalid/api", "https://agency.example.invalid?key=example"):
            with self.assertRaises(ReportError):
                evidence_created_url(host, "agency", DAY, DAY)
        for options in ({"page_size": 500}, {"page_offset": -1}, {"page_offset": True}):
            with self.assertRaises(ReportError):
                evidence_created_url("https://agency.example.invalid", "agency", DAY, DAY, **options)

    def test_token_form_encodes_reserved_characters_without_partner_by_default(self):
        # Deliberately synthetic values, not a credential from the attachments.
        result = token_form("synthetic-client", "synthetic +/= & only")
        parsed = parse_qs(result.decode("ascii"))
        self.assertEqual(parsed["client_secret"], ["synthetic +/= & only"])
        self.assertEqual(parsed["grant_type"], ["client_credentials"])
        self.assertNotIn("partner_id", parsed)
        self.assertIn(b"%3D", result)

    def test_legacy_token_partner_id_is_explicit(self):
        parsed = parse_qs(token_form("synthetic-client", "synthetic-only", "synthetic-agency").decode())
        self.assertEqual(parsed["partner_id"], ["synthetic-agency"])

    def test_throttle_honors_duration_and_uses_five_minute_fallback(self):
        self.assertEqual(retry_plan(429, "900").delay_seconds, 900)
        for value in (None, "", "not-a-duration", "-1"):
            self.assertEqual(retry_plan(429, value).delay_seconds, 300)

    def test_server_backoff_and_bounded_retries(self):
        self.assertEqual([retry_plan(503, attempt=i).delay_seconds for i in range(4)], [1, 2, 4, 8])
        self.assertEqual(retry_plan(500, attempt=6).action, "fail")

    def test_authentication_and_permission_errors_are_distinct(self):
        self.assertEqual(retry_plan(401).action, "refresh-token")
        self.assertEqual(retry_plan(401, token_already_refreshed=True).action, "fail")
        self.assertEqual(retry_plan(401, token_request=True).action, "fail")
        for status in (400, 403, 404):
            self.assertEqual(retry_plan(status).action, "fail")

    def test_internal_and_external_identifiers_are_not_serials(self):
        normalized = normalize_record(record())
        self.assertEqual(normalized["Evidence ID"], "SYNTHETIC-INTERNAL-001")
        self.assertEqual(normalized["External Evidence ID"], "SYNTHETIC-CASE-1")
        self.assertEqual(normalized["Evidence Serial Number"], "")
        self.assertEqual(normalized["Owner Badge ID"], "0007")
        self.assertEqual(normalized["Owner Groups"], "HSI Baltimore Users, Admin")

    def test_missing_category_metadata_cannot_appear_uncategorized(self):
        incomplete = record()
        del incomplete["categories"]
        with self.assertRaisesRegex(ReportError, "missing required API fields"):
            normalize_record(incomplete)

    def test_explicit_category_named_null_is_still_categorized(self):
        source = bundle(pages=[{"page_offset": 0, "data": [record(categories=["NULL"])]},
                               {"page_offset": 1, "data": []}])
        report = transform(read_page_bundle(json.dumps(source).encode()), DAY, "test")
        self.assertEqual(report.summary["Categorized Rows"], 1)
        self.assertEqual(report.summary["Total Uncategorized Items"], 0)

    def test_api_literal_names_are_not_csv_null_markers(self):
        source = bundle(pages=[{"page_offset": 0, "data": [record(ownerFirstName="Na", idExternal="NULL")]},
                               {"page_offset": 1, "data": []}])
        report = transform(read_page_bundle(json.dumps(source).encode()), DAY, "test")
        self.assertEqual(report.details[0]["Owner First Name"], "Na")
        self.assertEqual(report.details[0]["External Evidence ID"], "NULL")

    def test_unexpected_array_and_identifier_types_fail(self):
        for changes in ({"categories": "none"}, {"ownerGroups": [{"name": "HSI"}]},
                        {"ownerBadgeId": 7}, {"categories": [None]}):
            with self.assertRaises(ReportError):
                normalize_record(record(**changes))

    def test_updated_url_uses_utc_metadata_windows(self):
        start = datetime(2026, 10, 13, 6, tzinfo=timezone(timedelta(hours=-4)))
        end = datetime(2026, 10, 14, 10, tzinfo=timezone.utc)
        url = evidence_updated_url("https://agency.example", "agency-id", start, end, 1)
        query = parse_qs(urlsplit(url).query)
        self.assertEqual(query["reportType"], ["EvidenceUpdated"])
        self.assertEqual(query["updatedFromDateTime"], ["2026-10-13T10:00:00"])
        self.assertEqual(query["updatedToDateTime"], ["2026-10-14T10:00:00"])
        self.assertEqual(query["pageOffset"], ["1"])
        self.assertNotIn("fromDate", query)

    def test_updated_url_rejects_naive_or_reversed_times(self):
        now = datetime(2026, 10, 13, tzinfo=timezone.utc)
        for start, end in ((now.replace(tzinfo=None), now), (now, now - timedelta(seconds=1))):
            with self.assertRaises(ReportError):
                evidence_updated_url("https://agency.example", "agency-id", start, end)

    def test_updated_category_objects_preserve_presence(self):
        row = normalize_record(record(categories=[{"category": "NULL", "dateModified": "2026-10-13T14:00:00Z"}]), "EvidenceUpdated")
        self.assertEqual(json.loads(row["Categories"]), ["NULL"])
        self.assertEqual(normalize_record(record(categories=[]), "EvidenceUpdated")["Categories"], "")
        self.assertEqual(normalize_record(record(categories=None), "EvidenceUpdated")["Categories"], "")

    def test_updated_category_strings_or_invalid_objects_fail(self):
        for categories in (["case"], [{}], [{"category": ""}], [{"category": 5}]):
            with self.assertRaises(ReportError):
                normalize_record(record(categories=categories), "EvidenceUpdated")

    def test_short_page_requires_following_empty_page(self):
        self.assertEqual(len(normalize_page_bundle(bundle())), 1)
        incomplete = bundle(pages=[{"page_offset": 0, "data": [record()]}])
        with self.assertRaisesRegex(ReportError, "Incomplete report"):
            normalize_page_bundle(incomplete)

    def test_missing_out_of_order_or_repeated_pages_fail(self):
        for offsets in ((1, 2), (0, 50), (0, 0)):
            bad = bundle(pages=[{"page_offset": offsets[0], "data": [record()]},
                               {"page_offset": offsets[1], "data": []}])
            with self.assertRaisesRegex(ReportError, "contiguous"):
                normalize_page_bundle(bad)

    def test_zero_report_still_requires_successful_empty_page(self):
        self.assertEqual(normalize_page_bundle(bundle(pages=[{"page_offset": 0, "data": []}])), [])
        with self.assertRaises(ReportError):
            normalize_page_bundle(bundle(pages=[]))

    def test_no_pages_after_terminal_or_oversized_page(self):
        for pages in ([{"page_offset": 0, "data": []}, {"page_offset": 1, "data": [record()]}],
                      [{"page_offset": 0, "data": [record()] * 51}, {"page_offset": 1, "data": []}]):
            with self.assertRaises(ReportError):
                normalize_page_bundle(bundle(pages=pages))

    def test_date_scope_is_validated(self):
        for changes in ({"from_date": "20261013"}, {"from_date": "2026-02-30"},
                        {"from_date": "2026-10-14"}, {"page_size": 500}, {"sample_data": "true"}):
            with self.assertRaises(ReportError):
                normalize_page_bundle(bundle(**changes))

    def test_complete_api_fixture_matches_reference_counts(self):
        root = Path(__file__).resolve().parents[1]
        report = transform(read_page_bundle((root / "examples/axon-pages.sample.json").read_bytes()), DAY, "api")
        expected = json.loads((root / "examples/expected-summary.json").read_text())
        expected["Blank Rows Removed"] = 0  # APIs do not contain CSV blank rows.
        for field, value in expected.items():
            self.assertEqual(report.summary[field], value, field)


if __name__ == "__main__":
    unittest.main()

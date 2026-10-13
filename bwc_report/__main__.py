"""Run the portable MVP locally or from any scheduled cloud Python worker."""
import argparse
import hashlib
import json
import sys
import uuid
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .core import ReportError, read_csv, transform
from .axon import page_bundle_csv
from .export import publish_local


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate a Power BI-ready uncategorized evidence snapshot.")
    parser.add_argument("--input", type=Path, required=True, help="Evidence.com CSV export")
    parser.add_argument("--input-format", choices=("csv", "axon-page-bundle"), default="csv")
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--as-of", type=date.fromisoformat, help="Snapshot date (YYYY-MM-DD)")
    parser.add_argument("--source-date", type=date.fromisoformat, help="Known data extraction date; omit if unknown")
    parser.add_argument("--timezone", default="America/New_York")
    parser.add_argument("--encoding", default="utf-8-sig")
    parser.add_argument("--column-map", type=Path, help="JSON: canonical column name -> actual API/export column")
    parser.add_argument("--moderate-day", type=int, default=15)
    parser.add_argument("--critical-day", type=int, default=30)
    parser.add_argument("--xlsx", action="store_true", help="Also generate a formatted Excel workbook")
    parser.add_argument("--sample", action="store_true", help="Mark all run metadata and workbook as synthetic demo data")
    parser.add_argument("--fail-on-rejects", action="store_true", help="Do not publish a snapshot with rejected source records")
    args = parser.parse_args(argv)
    try:
        as_of = args.as_of or datetime.now(ZoneInfo(args.timezone)).date()
        mapping = json.loads(args.column_map.read_text()) if args.column_map else None
        if mapping is not None and (not isinstance(mapping, dict)
                or not all(isinstance(key, str) and isinstance(value, str) for key, value in mapping.items())):
            raise ReportError("Column map must be a JSON object mapping strings to strings.")
        content = args.input.read_bytes()
        if args.input_format == "axon-page-bundle" and mapping:
            raise ReportError("API bundle fields use the documented mapping; --column-map is for CSV input.")
        bundle = json.loads(content.decode("utf-8-sig")) if args.input_format == "axon-page-bundle" else None
        rows = read_csv(page_bundle_csv(bundle), null_markers=False) if args.input_format == "axon-page-bundle" else read_csv(content, args.encoding, mapping)
        if bundle is not None and bundle.get("sample_data") is True:
            args.sample = True
        report = transform(rows, as_of, uuid.uuid4().hex,
                           args.moderate_day, args.critical_day)
        report.summary["Sample Data"] = args.sample
        report.summary["Source Data Date"] = args.source_date.isoformat() if args.source_date else ""
        report.summary["Source Report"] = "EvidenceCreated" if bundle is not None else "CSV export"
        report.summary["Creation From Date"] = bundle["from_date"] if bundle is not None else ""
        report.summary["Creation To Date"] = bundle["to_date"] if bundle is not None else ""
        if report.rejected and args.fail_on_rejects:
            raise ReportError(f"{len(report.rejected)} source rows rejected; latest snapshot was not changed.")
        folder = publish_local(report, args.output, hashlib.sha256(content).hexdigest(),
                               args.source_date.isoformat() if args.source_date else None,
                               args.moderate_day, args.critical_day, args.xlsx, args.sample)
        print(json.dumps({"status": "complete", "sample_data": args.sample,
                          "snapshot_folder": str(folder), "summary": report.summary}, indent=2))
        return 0
    except (ReportError, OSError, ValueError, ZoneInfoNotFoundError) as exc:
        print(f"Report failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

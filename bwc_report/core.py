"""Business rules derived from the supplied process analysis.

Age bands use calendar days since upload, not a business-day policy deadline.
"""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Iterable

REQUIRED = ("Evidence ID", "Categories", "Status", "Date Uploaded", "Owner Groups")
OPTIONAL = (
    "Evidence Serial Number", "Evidence Type", "Owner Badge ID", "Owner First Name",
    "Owner Last Name", "Owner Role", "Serial Number", "Created Date (Record Start)",
)
NULLS = {"", "na", "n/a", "null", "none", "nan", "<na>"}
STATUSES = {"active", "queued for deletion"}
DETAIL_FIELDS = (
    "Run ID", "Snapshot Date", "Fiscal Year", "Evidence ID", "Days Since Upload",
    "Age Band", "Age Band Order", "Age Band Color", "Evidence Serial Number",
    "Evidence Type", "Status", "Owner Badge ID", "Owner First Name", "Owner Last Name",
    "Owner Role", "Owner Groups", "Serial Number", "Created Date (Record Start)",
    "Date Uploaded", "Days Between Create and Upload Date", "Component",
    "Component Name", "AOR", "Data Quality Notes",
)
METRIC_FIELDS = (
    "Total Uncategorized Items", "Normal Items", "Moderate Items", "Critical Items",
    "Average Days Since Upload", "Oldest Days Since Upload",
)
REJECT_FIELDS = ("Source Row", "Evidence ID", "Date Uploaded", "Reason")


class ReportError(ValueError):
    """An actionable source/configuration error; do not publish this run."""


def clean(value: object) -> str:
    text = "" if value is None else str(value).strip()
    return "" if text.casefold() in NULLS else text


def fiscal_year(day: date) -> int:
    return day.year + int(day.month >= 10)


def age_band(days: int, moderate: int = 15, critical: int = 30) -> tuple[str, int, str]:
    if not 0 < moderate < critical:
        raise ReportError("Thresholds must satisfy 0 < moderate day < critical day.")
    if days < 0:
        raise ReportError("Upload age cannot be negative.")
    if days >= critical:
        return "Critical", 3, "#C41230"
    if days >= moderate:
        return "Moderate", 2, "#FFA500"
    return "Normal", 1, "#FFFF00"


def organization(groups: str) -> tuple[str, str, str]:
    name = re.sub(r"\bUsers\b|\b2nd Line Sup\b", "", groups, flags=re.IGNORECASE)
    name = re.sub(r"\s+", " ", name.split(",", 1)[0]).strip()
    if not name:
        return "Unassigned", "Unassigned", "Unassigned"
    upper = name.upper()
    component = "Other"
    for prefix in ("HSI", "ERO", "FLETC", "FOIA"):
        if re.match(rf"^{prefix}(?:\b|$)", upper):
            component = prefix
            break
    if upper.startswith("OFFICE OF FIREARMS"):
        component = "OFTP"
    elif upper.startswith("OFFICE OF PROFESSIONAL"):
        component = "OPR"
    aor = re.sub(r"^(HSI|ERO)\b", "AOR", name, flags=re.IGNORECASE)
    return component, name, aor


def parse_day(value: str) -> date:
    # Preserve the vendor's calendar date; do not shift timestamp time zones.
    return date.fromisoformat(value[:10])


def read_csv(content: bytes, encoding: str = "utf-8-sig",
             column_map: dict[str, str] | None = None) -> list[dict[str, str]]:
    try:
        reader = csv.DictReader(io.StringIO(content.decode(encoding), newline=""))
        if reader.fieldnames is None:
            raise ReportError("Source CSV has no header.")
        headers = [name.strip() for name in reader.fieldnames]
        if len(set(headers)) != len(headers):
            raise ReportError("Source CSV has duplicate column names.")
        reader.fieldnames = headers
        mapping = {key: (column_map or {}).get(key, key) for key in REQUIRED + OPTIONAL}
        missing = [key for key in REQUIRED if mapping[key] not in headers]
        if missing:
            raise ReportError("Missing required source columns: " + ", ".join(missing))
        rows = []
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ReportError(f"CSV row {reader.line_num} has an unexpected number of cells.")
            if not any(clean(value) for value in row.values()):
                rows.append({"__blank__": "1"})
                continue
            mapped = {key: clean(row.get(source, "")) for key, source in mapping.items()}
            mapped["__row__"] = str(reader.line_num)
            rows.append(mapped)
        return rows
    except (UnicodeError, csv.Error) as exc:
        raise ReportError("Could not read source CSV; check encoding and delimiter.") from exc


@dataclass
class Report:
    details: list[dict]
    rejected: list[dict]
    summary: dict


def metrics(records: list[dict]) -> dict:
    ages = [row["Days Since Upload"] for row in records]
    return {
        "Total Uncategorized Items": len(records),
        **{f"{band} Items": sum(row["Age Band"] == band for row in records)
           for band in ("Normal", "Moderate", "Critical")},
        "Average Days Since Upload": sum(ages) / len(ages) if ages else 0,
        "Oldest Days Since Upload": max(ages, default=0),
    }


def transform(rows: Iterable[dict[str, str]], as_of: date, run_id: str,
              moderate: int = 15, critical: int = 30) -> Report:
    age_band(0, moderate, critical)  # Validate configuration before an empty run.
    counts = {"Input Rows": 0, "Blank Rows Removed": 0, "Duplicate Rows Removed": 0,
              "Excluded Status Rows": 0, "Categorized Rows": 0, "Rejected Rows": 0}
    seen: dict[str, dict] = {}
    details, rejected = [], []
    for row in rows:
        if row.get("__blank__"):
            counts["Blank Rows Removed"] += 1
            continue
        counts["Input Rows"] += 1
        evidence_id = row["Evidence ID"]
        canonical = {key: row.get(key, "") for key in REQUIRED + OPTIONAL}
        if evidence_id and evidence_id in seen:
            if seen[evidence_id] != canonical:
                raise ReportError("Conflicting duplicate evidence ID detected; resolve the source before publishing.")
            counts["Duplicate Rows Removed"] += 1
            continue
        if evidence_id:
            seen[evidence_id] = canonical
        if row["Status"].casefold() not in STATUSES:
            counts["Excluded Status Rows"] += 1
            continue
        if row["Categories"]:
            counts["Categorized Rows"] += 1
            continue
        reason, uploaded = "", None
        if not evidence_id:
            reason = "Missing evidence ID"
        else:
            try:
                uploaded = parse_day(row["Date Uploaded"])
                if uploaded > as_of:
                    reason = "Upload date is after snapshot date"
            except ValueError:
                reason = "Missing or invalid upload date"
        if reason:
            rejected.append({"Source Row": row.get("__row__", ""), "Evidence ID": evidence_id,
                             "Date Uploaded": row["Date Uploaded"], "Reason": reason})
            counts["Rejected Rows"] += 1
            continue
        assert uploaded is not None
        days = (as_of - uploaded).days
        band, order, color = age_band(days, moderate, critical)
        component, component_name, aor = organization(row["Owner Groups"])
        created, upload_delay, notes = "", "", []
        if row.get("Created Date (Record Start)"):
            try:
                created_day = parse_day(row["Created Date (Record Start)"])
                created = created_day.isoformat()
                if created_day <= uploaded:
                    upload_delay = (uploaded - created_day).days
                else:
                    notes.append("Created date is after upload date")
            except ValueError:
                notes.append("Invalid created date")
        if not row.get("Owner Badge ID"):
            notes.append("Missing owner badge ID")
        if component == "Other":
            notes.append("Unrecognized component")
        details.append({
            **{key: row.get(key, "") for key in OPTIONAL},
            "Status": row["Status"],
            "Run ID": run_id, "Snapshot Date": as_of.isoformat(), "Fiscal Year": fiscal_year(as_of),
            "Evidence ID": evidence_id, "Days Since Upload": days, "Age Band": band,
            "Age Band Order": order, "Age Band Color": color, "Owner Groups": row["Owner Groups"],
            "Date Uploaded": uploaded.isoformat(), "Created Date (Record Start)": created,
            "Days Between Create and Upload Date": upload_delay, "Component": component,
            "Component Name": component_name, "AOR": aor, "Data Quality Notes": "; ".join(notes),
        })
    details.sort(key=lambda item: (-item["Days Since Upload"], item["Evidence ID"]))
    summary = {"Run ID": run_id, "Snapshot Date": as_of.isoformat(), "Fiscal Year": fiscal_year(as_of),
               **metrics(details), **counts}
    assert counts["Input Rows"] == (len(details) + counts["Duplicate Rows Removed"]
        + counts["Excluded Status Rows"] + counts["Categorized Rows"] + counts["Rejected Rows"])
    return Report(details, rejected, summary)


def summarize(report: Report, dimensions: tuple[str, ...]) -> list[dict]:
    groups = defaultdict(list)
    for row in report.details:
        groups[tuple(row[key] for key in dimensions)].append(row)
    result = [
        {**{key: report.summary[key] for key in ("Run ID", "Snapshot Date", "Fiscal Year")},
         **dict(zip(dimensions, key)), **metrics(records)}
        for key, records in groups.items()
    ]
    return sorted(result, key=lambda row: (-row["Total Uncategorized Items"],
                                          tuple(str(row[key]) for key in dimensions)))

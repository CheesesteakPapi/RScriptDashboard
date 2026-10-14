"""Generate a portable PBIP/PBIR source template; requires no account or credentials.

This creates project definitions, not a compiled PBIX or a Desktop validation.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bwc_report.core import DETAIL_FIELDS, REJECT_FIELDS, read_csv, transform

PROJECT = ROOT / "powerbi/template"
REPORT = PROJECT / "BWC Uncategorized.Report"
MODEL = PROJECT / "BWC Uncategorized.SemanticModel"
SCHEMA = "https://developer.microsoft.com/json-schemas/"
DAY = date(2026, 10, 13)


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def m_text(value: str) -> str:
    # Escape M literals, including the escape-introducer in arbitrary source text.
    return '"' + value.replace("#", "#(#)").replace('"', '""') + '"'


def expression(name: str, source: str) -> dict:
    return {"name": name, "kind": "m", "expression": source.splitlines()}


def measure_name(name: str) -> str:
    return name if name.startswith("Report ") else "Report " + name


def column(name: str, kind: str = "string", hidden: bool = False) -> dict:
    result = {"name": name, "dataType": kind, "sourceColumn": name, "summarizeBy": "none"}
    if hidden:
        result["isHidden"] = True
    if kind == "dateTime":
        result["formatString"] = "yyyy-MM-dd"
    elif kind == "int64":
        result["formatString"] = "#,0"
    elif kind == "double":
        result["formatString"] = "0.0"
    return result


def sample_expression() -> str:
    report = transform(read_csv((ROOT / "examples/evidence.sample.csv").read_bytes()), DAY,
                       "synthetic_template_20261013")
    report.summary.update({"Sample Data": True, "Source Data Date": DAY.isoformat(),
                           "Source Report": "Synthetic CSV fixture", "Creation From Date": "2024-03-11",
                           "Creation To Date": DAY.isoformat(), "Refresh Mode": "Synthetic preview",
                           "Previous Run ID": "", "Updated From UTC": "", "Updated Through UTC": "",
                           "State Rows": 0, "Created Rows Received": 0, "Updated Rows Received": 0,
                           "Out of Scope Updates": 0})
    payload = {"Details": report.details, "Snapshot": [report.summary], "Rejected": report.rejected}
    encoded = m_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    return f'''let
    Payload = Json.Document({encoded}),
    RawDetails = Table.FromRecords(Payload[Details]),
    Details = Table.TransformColumnTypes(Table.ReplaceValue(RawDetails, "", null,
        Replacer.ReplaceValue, {{"Snapshot Date", "Date Uploaded", "Created Date (Record Start)", "Days Between Create and Upload Date"}}),
        {{{{"Snapshot Date", type date}}, {{"Date Uploaded", type date}}, {{"Created Date (Record Start)", type date}},
         {{"Fiscal Year", Int64.Type}}, {{"Days Since Upload", Int64.Type}}, {{"Age Band Order", Int64.Type}},
         {{"Days Between Create and Upload Date", Int64.Type}}}}),
    Snapshot = Table.ReplaceValue(Table.FromRecords(Payload[Snapshot]), "", null, Replacer.ReplaceValue,
        {{"Source Data Date", "Creation From Date", "Creation To Date"}}),
    Rejected = Table.FromRecords(Payload[Rejected])
in [Details=Details, Snapshot=Snapshot, Rejected=Rejected]'''


def build_model() -> None:
    source = (ROOT / "powerbi/ReportSourceExcel.pq").read_text()
    source = source.replace('SiteUrl = "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE",',
                            'SiteUrl = Text.TrimEnd(SharePointSiteUrl, {"/"}),')
    source = source.replace('ReportFolderUrl = SiteUrl & "/Shared Documents/BWC Reporting/",',
                            'ReportFolderUrl = SiteUrl & "/" & Text.Trim(ReportFolderPath, {"/"}) & "/",')
    source = source.replace('Files = SharePoint.Files(SiteUrl, [ApiVersion=15]),',
                            'Files = if SiteUrl="" then error "Set SharePointSiteUrl before disabling sample data"\n'
                            '        else SharePoint.Files(SiteUrl, [ApiVersion=15]),')
    expressions = [
        expression("UseSampleData", 'true meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]'),
        expression("SharePointSiteUrl", '"" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]'),
        expression("ReportFolderPath", '"Shared Documents/BWC Reporting" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'),
        expression("SampleSource", sample_expression()),
        expression("SharePointSource", source),
        expression("ReportSource", "if UseSampleData then SampleSource else SharePointSource"),
    ]
    dates = {"Snapshot Date", "Created Date (Record Start)", "Date Uploaded"}
    integers = {"Fiscal Year", "Days Since Upload", "Age Band Order", "Days Between Create and Upload Date"}
    hidden = {"Age Band Order", "Age Band Color", "Run ID", "Fiscal Year"}
    details_columns = [column(name, "dateTime" if name in dates else "int64" if name in integers else "string", name in hidden)
                       for name in DETAIL_FIELDS]
    next(item for item in details_columns if item["name"] == "Age Band")["sortByColumn"] = "Age Band Order"
    detail_table = {"name": "Uncategorized", "columns": details_columns,
                    "partitions": [{"name": "Uncategorized", "mode": "import", "source": {
                        "type": "m", "expression": (ROOT / "powerbi/Uncategorized.pq").read_text().splitlines()}}]}
    snapshot_types = {
        "Run ID": "string", "Snapshot Date": "dateTime", "Source Data Date": "dateTime",
        "Source Report": "string", "Creation From Date": "dateTime", "Creation To Date": "dateTime",
        "Refresh Mode": "string", "Previous Run ID": "string", "Updated From UTC": "string", "Updated Through UTC": "string",
        "State Rows": "int64", "Created Rows Received": "int64", "Updated Rows Received": "int64", "Out of Scope Updates": "int64",
        "Fiscal Year": "int64", "Total Uncategorized Items": "int64", "Normal Items": "int64", "Moderate Items": "int64",
        "Critical Items": "int64", "Average Days Since Upload": "double", "Oldest Days Since Upload": "int64",
        "Input Rows": "int64", "Blank Rows Removed": "int64", "Duplicate Rows Removed": "int64",
        "Excluded Status Rows": "int64", "Categorized Rows": "int64", "Rejected Rows": "int64", "Sample Data": "boolean",
    }
    snapshot_table = {"name": "Snapshot", "description": "Disconnected refresh metadata; do not relate to the evidence fact table.",
                      "columns": [column(name, kind) for name, kind in snapshot_types.items()],
                      "partitions": [{"name": "Snapshot", "mode": "import", "source": {
                          "type": "m", "expression": (ROOT / "powerbi/Snapshot.pq").read_text().splitlines()}}]}
    rejected_table = {"name": "RejectedRows", "description": "Source exclusions for the report's authorized remediation audience.",
                      "columns": [column(name, "int64" if name == "Source Row" else "string") for name in REJECT_FIELDS],
                      "partitions": [{"name": "RejectedRows", "mode": "import", "source": {
                          "type": "m", "expression": (ROOT / "powerbi/RejectedRows.pq").read_text().splitlines()}}]}
    dax = re.sub(r"(?m)^//.*\n?", "", (ROOT / "powerbi/measures.dax").read_text()).strip()
    measures = []
    for block in re.split(r"\n\s*\n", dax):
        name, body = block.split("=", 1)
        name = name.strip()
        base_name = name.removeprefix("Report ")
        item = {"name": name, "expression": body.strip().splitlines(), "displayFolder": "Status" if base_name in {
            "Data Mode", "Snapshot Date", "Creation From Date", "Creation To Date", "Updated Through UTC", "Rejected Source Rows"} else "Backlog"}
        if base_name in {"Snapshot Date", "Creation From Date", "Creation To Date"}:
            item["formatString"] = "yyyy-MM-dd"
        elif base_name == "Average Days Since Upload":
            item["formatString"] = "0.0"
        elif base_name not in {"Data Mode", "Age Band Color", "Updated Through UTC"}:
            item["formatString"] = "#,0"
        if base_name == "Data Mode":
            item["expression"] = ['SWITCH(TRUE(), COUNTROWS(\'Snapshot\') <> 1, "SOURCE NOT READY",',
                                  'SELECTEDVALUE(\'Snapshot\'[Sample Data]) = TRUE(), "SYNTHETIC DEMO DATA",',
                                  'ISBLANK(SELECTEDVALUE(\'Snapshot\'[Sample Data])), "SOURCE MODE UNKNOWN", "PRODUCTION DATA")']
        measures.append(item)
    measures.extend([
        {"name": measure_name("Subtitle"), "displayFolder": "Status", "expression": [
            '"Snapshot " & FORMAT([Report Snapshot Date], "yyyy-MM-dd") & "  |  Recording scope " &',
            'FORMAT([Report Creation From Date], "yyyy-MM-dd") & " to " & FORMAT([Report Creation To Date], "yyyy-MM-dd")']},
        {"name": measure_name("Updated Window Label"), "displayFolder": "Status", "expression": [
            'VAR Stamp = [Report Updated Through UTC]',
            'RETURN IF(ISBLANK(Stamp) || Stamp = "", "API update watermark not available", "Updated through " & Stamp & " UTC")']},
        {"name": measure_name("Rejected Records"), "expression": "COALESCE(COUNTROWS('RejectedRows'), 0)", "formatString": "#,0", "displayFolder": "Quality"},
        {"name": measure_name("Empty Backlog Message"), "expression": 'IF([Report Total Uncategorized Items] = 0, "No uncategorized evidence in the selected scope", "")', "displayFolder": "Status"},
        {"name": measure_name("Age Band Font Color"), "expression": 'IF(SELECTEDVALUE(\'Uncategorized\'[Age Band]) = "Critical", "#FFFFFF", "#243746")', "displayFolder": "Formatting"},
    ])
    detail_table["measures"] = measures
    write(MODEL / "definition.pbism", {"$schema": SCHEMA + "fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
                                     "version": "1.0", "settings": {"qnaEnabled": False}})
    write(MODEL / "model.bim", {
        "name": "BWC Uncategorized", "compatibilityLevel": 1567,
        "model": {"culture": "en-US", "defaultPowerBIDataSourceVersion": "powerBI_V3", "sourceQueryCulture": "en-US",
                  "dataAccessOptions": {"legacyRedirects": True, "returnErrorValuesAsNull": True},
                  "annotations": [{"name": "PBI_QueryOrder", "value": json.dumps([item["name"] for item in expressions] + ["Uncategorized", "Snapshot", "RejectedRows"])},
                                  {"name": "__PBI_TimeIntelligenceEnabled", "value": "0"}],
                  "expressions": expressions, "tables": [detail_table, snapshot_table, rejected_table]}})


def literal(value: str | bool | int) -> dict:
    if isinstance(value, bool):
        rendered = "true" if value else "false"
    elif isinstance(value, int):
        rendered = str(value) + "D"
    else:
        rendered = "'" + value.replace("'", "''") + "'"
    return {"expr": {"Literal": {"Value": rendered}}}


def color(value: str) -> dict:
    return {"solid": {"color": literal(value)}}


def field(table: str, name: str, measure: bool = False) -> dict:
    if measure:
        name = measure_name(name)
    return {"Measure" if measure else "Column": {"Expression": {"SourceRef": {"Entity": table}}, "Property": name}}


def projection(table: str, name: str, measure: bool = False, label: str | None = None) -> dict:
    if measure:
        label = label or name.removeprefix("Report ")
        name = measure_name(name)
    item = {"field": field(table, name, measure), "queryRef": table + "." + name, "nativeQueryRef": name}
    if label:
        item["displayName"] = label
    return item


def props(**values: dict) -> list:
    return [{"properties": values}]


def visual(page: str, name: str, kind: str, rect: tuple, title: str, roles: dict | None = None,
           objects: dict | None = None, sort: tuple | None = None, plain: bool = False) -> None:
    x, y, width, height, order = rect
    container = {"title": props(show=literal(bool(title)), text=literal(title), fontSize=literal(13),
                                 fontColor=color("#243746"), bold=literal(True)),
                 "background": props(show=literal(not plain), color=color("#FFFFFF"), transparency=literal(0)),
                 "border": props(show=literal(not plain), color=color("#E0E6EB"), radius=literal(6)),
                 "general": props(altText=literal(title or name.replace("_", " ")))}
    config = {"visualType": kind, "visualContainerObjects": container, "drillFilterOtherVisuals": True}
    if roles:
        config["query"] = {"queryState": {role: {"projections": values} for role, values in roles.items()}}
        if sort:
            config["query"]["sortDefinition"] = {"sort": [{"field": sort[0], "direction": sort[1]}], "isDefaultSort": False}
    if objects:
        config["objects"] = objects
    if kind == "slicer" and roles:
        property_name = roles["Values"][0]["field"]["Column"]["Property"]
        config["syncGroup"] = {"groupName": "BWC_" + property_name, "fieldChanges": True, "filterChanges": True}
    write(REPORT / "definition/pages" / page / "visuals" / name / "visual.json", {
        "$schema": SCHEMA + "fabric/item/report/definition/visualContainer/2.4.0/schema.json", "name": name,
        "position": {"x": x, "y": y, "z": order * 1000, "width": width, "height": height, "tabOrder": order}, "visual": config})


def text(page: str, name: str, value: str, rect: tuple, size: int = 12, ink: str = "#506477") -> None:
    visual(page, name, "textbox", rect, "", objects={"general": [{"properties": {"paragraphs": [{
        "textRuns": [{"value": value, "textStyle": {"fontFamily": "Segoe UI", "fontSize": f"{size}pt", "color": ink}}]}]}}]}, plain=True)


def card(page: str, name: str, measure: str, rect: tuple, title: str = "", ink: str = "#243746", size: int = 36) -> None:
    visual(page, name, "card", rect, title, {"Values": [projection("Uncategorized", measure, True)]},
           {"labels": props(color=color(ink), fontSize=literal(size), labelDisplayUnits=literal(0)),
            "categoryLabels": props(show=literal(False))})


def slicer(page: str, name: str, col: str, rect: tuple) -> None:
    visual(page, name, "slicer", rect, col, {"Values": [projection("Uncategorized", col)]},
           {"data": props(mode=literal("Dropdown")), "selection": props(singleSelect=literal(False), selectAllCheckboxEnabled=literal(True))})


def build_report() -> None:
    write(PROJECT / "BWC Uncategorized.pbip", {"$schema": SCHEMA + "fabric/pbip/pbipProperties/1.0.0/schema.json",
        "version": "1.0", "artifacts": [{"report": {"path": REPORT.name}}], "settings": {"enableAutoRecovery": True}})
    write(REPORT / "definition.pbir", {"$schema": SCHEMA + "fabric/item/report/definitionProperties/2.0.0/schema.json",
                                      "version": "4.0", "datasetReference": {"byPath": {"path": "../" + MODEL.name}}})
    write(REPORT / "definition/version.json", {
        "$schema": SCHEMA + "fabric/item/report/definition/versionMetadata/1.0.0/schema.json",
        "version": "2.0.0"})
    theme_name = "BWCTheme"
    write(REPORT / "StaticResources/RegisteredResources/BWCTheme.json", {
        "name": "BWC reporting", "dataColors": ["#245C82", "#C41230", "#D98500", "#6B7480", "#499898", "#7B6299"],
        "background": "#F4F7FA", "foreground": "#243746", "tableAccent": "#245C82",
        "textClasses": {"title": {"fontFace": "Segoe UI", "fontSize": 13},
                        "label": {"fontFace": "Segoe UI", "fontSize": 11}, "callout": {"fontFace": "Segoe UI", "fontSize": 36}}})
    write(REPORT / "definition/report.json", {
        "$schema": SCHEMA + "fabric/item/report/definition/report/3.0.0/schema.json",
        "themeCollection": {"customTheme": {"name": theme_name, "type": "RegisteredResources",
            "reportVersionAtImport": {"visual": "2.4.0", "page": "2.0.0", "report": "3.0.0"}}},
        "resourcePackages": [{"name": "RegisteredResources", "type": "RegisteredResources", "items": [
            {"name": theme_name, "path": "BWCTheme.json", "type": "CustomTheme"}]}],
        "settings": {"defaultFilterActionIsDataFilter": True, "useStylableVisualContainerHeader": True,
                     "pagesPosition": "Bottom"}})
    pages = [("overview", "Overview"), ("remediation", "Remediation"), ("quality", "Data Quality")]
    write(REPORT / "definition/pages/pages.json", {"$schema": SCHEMA + "fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
                                                   "pageOrder": [name for name, _ in pages], "activePageName": "overview"})
    for page, label in pages:
        write(REPORT / "definition/pages" / page / "page.json", {
            "$schema": SCHEMA + "fabric/item/report/definition/page/2.0.0/schema.json", "name": page, "displayName": label,
            "displayOption": "FitToPage", "width": 1280, "height": 800,
            "objects": {"background": props(color=color("#F4F7FA"), transparency=literal(0))}})
        text(page, "heading", "BWC  /  " + label, (24, 12, 770, 46, 0), 24, "#243746")
        card(page, "data_mode", "Data Mode", (850, 12, 406, 46, 1), ink="#A5132A", size=16)
        card(page, "scope_status", "Report Subtitle", (24, 66, 1232, 42, 2), size=14)
        text(page, "age_rule", "Upload age in calendar days: Normal 0–14  •  Moderate 15–29  •  Critical 30+", (24, 754, 1232, 28, 99), 11)
    for index, (measure, title, ink) in enumerate([
        ("Total Uncategorized Items", "Total uncategorized", "#245C82"),
        ("Critical Items", "Critical  ·  30+ days", "#C41230"),
        ("Moderate Items", "Moderate  ·  15–29 days", "#AE6900"),
        ("Normal Items", "Normal  ·  0–14 days", "#665B00")]):
        card("overview", "kpi_" + str(index), measure, (24 + index * 312, 126, 296, 114, 3 + index), title, ink)
    slicer("overview", "component_filter", "Component", (24, 256, 296, 92, 7))
    slicer("overview", "aor_filter", "AOR", (336, 256, 452, 92, 8))
    slicer("overview", "band_filter", "Age Band", (804, 256, 452, 92, 9))
    series = [projection("Uncategorized", name, True) for name in ("Critical Items", "Moderate Items", "Normal Items")]
    series_colors = [{"selector": {"metadata": "Uncategorized." + measure_name(name)}, "properties": {"fill": color(ink)}}
                     for name, ink in [("Critical Items", "#C41230"), ("Moderate Items", "#FFA500"), ("Normal Items", "#FFFF00")]]
    visual("overview", "component_backlog", "clusteredBarChart", (24, 364, 602, 266, 10), "Backlog by component and age",
           {"Category": [projection("Uncategorized", "Component")], "Y": series}, {"dataPoint": series_colors, "labels": props(show=literal(True))},
           sort=(field("Uncategorized", "Critical Items", True), "Descending"))
    visual("overview", "aor_backlog", "clusteredBarChart", (642, 364, 614, 266, 11), "Backlog by AOR",
           {"Category": [projection("Uncategorized", "AOR")], "Y": [projection("Uncategorized", "Total Uncategorized Items", True)]},
           {"labels": props(show=literal(True))}, sort=(field("Uncategorized", "Total Uncategorized Items", True), "Descending"))
    card("overview", "oldest", "Oldest Days Since Upload", (24, 646, 224, 88, 12), "Oldest upload age (days)", size=24)
    card("overview", "average", "Average Days Since Upload", (264, 646, 224, 88, 13), "Average upload age (days)", size=24)
    card("overview", "rejected", "Rejected Source Rows", (504, 646, 224, 88, 14), "Rejected source records", "#A5132A", size=24)
    card("overview", "watermark", "Updated Window Label", (744, 646, 512, 88, 15), "Acquisition status", size=12)
    for index, (col, width) in enumerate([("Component", 280), ("AOR", 400), ("Age Band", 280), ("Owner Badge ID", 224)]):
        x = [24, 320, 736, 1032][index]
        slicer("remediation", "filter_" + str(index), col, (x, 126, width, 96, 3 + index))
    detail_columns = ["Evidence ID", "External Evidence ID", "Days Since Upload", "Age Band", "Status", "Component", "AOR",
                      "Owner Badge ID", "Owner First Name", "Owner Last Name", "Date Uploaded", "Created Date (Record Start)", "Data Quality Notes"]
    visual("remediation", "evidence_detail", "tableEx", (24, 240, 1232, 438, 7), "Uncategorized evidence  ·  oldest first",
           {"Values": [projection("Uncategorized", name) for name in detail_columns]},
           {"grid": props(textSize=literal(11), rowPadding=literal(5)), "columnHeaders": props(fontColor=color("#243746"), bold=literal(True)),
            "values": [{"selector": {"metadata": "Uncategorized." + col}, "properties": {
                "backColor": {"solid": {"color": {"expr": field("Uncategorized", "Age Band Color", True)}}},
                "fontColor": {"solid": {"color": {"expr": field("Uncategorized", "Age Band Font Color", True)}}}}}
                for col in ("Days Since Upload", "Age Band")],
            "total": props(totals=literal(False))}, sort=(field("Uncategorized", "Days Since Upload"), "Descending"))
    card("remediation", "selected_count", "Total Uncategorized Items", (24, 694, 272, 42, 8), "Selected records", size=18)
    card("remediation", "empty_state", "Empty Backlog Message", (312, 694, 944, 42, 9), size=14)
    card("quality", "source_rejected", "Rejected Source Rows", (24, 126, 296, 106, 3), "Source rejections", "#A5132A")
    card("quality", "source_snapshot", "Snapshot Date", (336, 126, 296, 106, 4), "Snapshot date", size=24)
    card("quality", "source_watermark", "Updated Window Label", (648, 126, 608, 106, 5), "API update window", size=14)
    visual("quality", "rejection_reasons", "clusteredBarChart", (24, 248, 464, 240, 6), "Rejected records by reason",
           {"Category": [projection("RejectedRows", "Reason")], "Y": [projection("Uncategorized", "Rejected Records", True)]},
           {"labels": props(show=literal(True))}, sort=(field("Uncategorized", "Rejected Records", True), "Descending"))
    visual("quality", "refresh_metadata", "tableEx", (504, 248, 752, 240, 7), "Published source metadata",
           {"Values": [projection("Snapshot", name) for name in ["Run ID", "Source Report", "Refresh Mode", "Creation From Date",
             "Creation To Date", "Updated Through UTC", "State Rows", "Created Rows Received", "Updated Rows Received"]]},
           {"grid": props(textSize=literal(10)), "total": props(totals=literal(False))})
    visual("quality", "rejected_detail", "tableEx", (24, 504, 1232, 184, 8), "Excluded source records  ·  resolve before publication",
           {"Values": [projection("RejectedRows", name) for name in REJECT_FIELDS]},
           {"grid": props(textSize=literal(11)), "total": props(totals=literal(False))}, sort=(field("RejectedRows", "Source Row"), "Ascending"))
    text("quality", "quality_note", "Calendar age is not a three-business-day compliance measure. Source metadata is independent of evidence slicers.",
         (24, 706, 1232, 34, 9), 12)


if __name__ == "__main__":
    build_model()
    build_report()
    print("Generated PBIP template:", PROJECT / "BWC Uncategorized.pbip")

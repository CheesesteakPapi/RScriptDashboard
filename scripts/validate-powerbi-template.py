"""Validate PBIP bindings and embedded sample data without a Power BI runtime.

Optionally validate report documents with Microsoft's downloaded schema folder.
The schema check requires jsonschema and referencing in the verification environment.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "powerbi/template"


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def validate_bindings() -> None:
    shortcut = read(PROJECT / "BWC Uncategorized.pbip")
    report = PROJECT / shortcut["artifacts"][0]["report"]["path"]
    definition = read(report / "definition.pbir")
    model_dir = (report / definition["datasetReference"]["byPath"]["path"]).resolve()
    model = read(model_dir / "model.bim")["model"]
    assert model_dir.is_relative_to(PROJECT.resolve())
    tables = {table["name"]: table for table in model["tables"]}
    assert set(tables) == {"Uncategorized", "Snapshot", "RejectedRows"}
    assert not model.get("relationships"), "Refresh metadata must remain disconnected"
    columns = {name: {col["name"]: col for col in table["columns"]} for name, table in tables.items()}
    measures = {name: {item["name"] for item in table.get("measures", [])} for name, table in tables.items()}
    for name, table in tables.items():
        assert len(columns[name]) == len(table["columns"]), "Duplicate model columns"
        assert len(measures[name]) == len(table.get("measures", [])), "Duplicate measures"
        for col in table["columns"]:
            if "sortByColumn" in col:
                assert col["sortByColumn"] in columns[name]
    assert columns["Uncategorized"]["Age Band"]["sortByColumn"] == "Age Band Order"
    assert columns["Uncategorized"]["Owner Badge ID"]["dataType"] == "string"
    expressions = {item["name"]: "\n".join(item["expression"]) for item in model["expressions"]}
    assert expressions["UseSampleData"].startswith("true meta"), "Template must open in sample mode"
    assert '"" meta' in expressions["SharePointSiteUrl"], "Do not embed agency destinations"
    match = re.search(r'Payload = Json.Document\("(.*?)"\),', expressions["SampleSource"], re.DOTALL)
    assert match, "Missing embedded preview payload"
    payload = json.loads(match.group(1).replace('""', '"').replace("#(#)", "#"))
    details = payload["Details"]
    snapshot = payload["Snapshot"][0]
    assert snapshot["Sample Data"] is True
    assert snapshot["Creation From Date"] == "2024-03-11"
    expected = read(ROOT / "examples/expected-summary.json")
    assert len(details) == expected["Total Uncategorized Items"]
    assert len({row["Evidence ID"] for row in details}) == len(details)
    counts = Counter(row["Age Band"] for row in details)
    for band in ("Normal", "Moderate", "Critical"):
        assert counts[band] == expected[band + " Items"]
    assert len(payload["Rejected"]) == expected["Rejected Rows"]
    for row in details:
        age = row["Days Since Upload"]
        assert row["Age Band"] == ("Critical" if age >= 30 else "Moderate" if age >= 15 else "Normal")
    order = read(report / "definition/pages/pages.json")
    assert len(order["pageOrder"]) == 3 and order["activePageName"] in order["pageOrder"]
    visual_count = 0
    for name in order["pageOrder"]:
        folder = report / "definition/pages" / name
        page = read(folder / "page.json")
        assert page["name"] == name
        visuals = list(folder.glob("visuals/*/visual.json"))
        names, tabs = set(), set()
        for path in visuals:
            visual = read(path)
            assert visual["name"] not in names
            names.add(visual["name"])
            pos = visual["position"]
            assert pos["tabOrder"] not in tabs
            tabs.add(pos["tabOrder"])
            assert pos["x"] >= 0 and pos["y"] >= 0
            assert pos["x"] + pos["width"] <= page["width"]
            assert pos["y"] + pos["height"] <= page["height"]
            for node in walk(visual):
                for kind, catalog in (("Column", columns), ("Measure", measures)):
                    if kind in node:
                        item = node[kind]
                        entity = item["Expression"]["SourceRef"]["Entity"]
                        assert item["Property"] in catalog[entity], f"Missing {kind}: {entity}.{item['Property']}"
            visual_count += 1
    print(f"PASS: project bindings, {len(tables)} tables, {sum(map(len, measures.values()))} measures, 3 pages, {visual_count} visuals")
    print("PASS: embedded sample counts 8 total / 2 normal / 2 moderate / 4 critical / 3 rejected; scope and age rules")


def validate_schemas(folder: Path) -> None:
    from jsonschema import validators
    from referencing import Registry, Resource
    registry = Registry()
    schemas = {}
    # This folder mirrors microsoft/json-schemas paths; a theme schema is separate.
    for path in (folder / "fabric").rglob("*.json"):
        value = read(path)
        uri = "https://developer.microsoft.com/json-schemas/" + path.relative_to(folder).as_posix()
        schemas[uri] = value
        registry = registry.with_resource(uri, Resource.from_contents(value))
    count = 0
    for path in PROJECT.rglob("*"):
        if path.suffix not in (".json", ".pbip", ".pbir", ".pbism"):
            continue
        value = read(path)
        uri = value.get("$schema")
        if not uri:
            continue
        schema = schemas[uri]
        validators.validator_for(schema)(schema, registry=registry).validate(value)
        count += 1
    theme_schema = folder / "reportThemeSchema-2.157.json"
    if theme_schema.exists():
        schema = read(theme_schema)
        theme = read(PROJECT / "BWC Uncategorized.Report/StaticResources/RegisteredResources/BWCTheme.json")
        validators.validator_for(schema)(schema).validate(theme)
        print("PASS: report theme against Microsoft's August 2026 theme schema")
    print(f"PASS: {count} project/report documents against Microsoft's official JSON schemas")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema-folder", type=Path)
    args = parser.parse_args()
    validate_bindings()
    if args.schema_folder:
        validate_schemas(args.schema_folder)
    print("Power BI Desktop open/refresh/render and DAX evaluation remain unverified.")

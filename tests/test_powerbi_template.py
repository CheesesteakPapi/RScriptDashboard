"""Regression checks for project files required by Power BI Desktop's loader."""
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("template_validation", ROOT / "scripts/validate-powerbi-template.py")
VALIDATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATION)


class TemplateLoaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / "template"
        shutil.copytree(ROOT / "powerbi/template", self.project)
        self.version = self.project / "BWC Uncategorized.Report/definition/version.json"

    def test_generated_project_has_required_loader_files(self):
        self.assertEqual(VALIDATION.validate_required_files(self.project).name, "BWC Uncategorized.Report")

    def test_missing_report_version_metadata_is_rejected(self):
        self.version.unlink()
        with self.assertRaisesRegex(AssertionError, "Missing required Power BI report file: definition/version.json"):
            VALIDATION.validate_required_files(self.project)

    def test_wrong_report_definition_version_is_rejected(self):
        value = json.loads(self.version.read_text())
        value["version"] = "4.0"  # Entry-point .pbir version is not the definition/version.json version.
        self.version.write_text(json.dumps(value))
        with self.assertRaisesRegex(AssertionError, "Unsupported report definition version"):
            VALIDATION.validate_required_files(self.project)

    def model(self):
        return json.loads((self.project / "BWC Uncategorized.SemanticModel/model.bim").read_text())["model"]

    def test_generated_measure_names_do_not_collide_with_columns(self):
        VALIDATION.validate_model_names(self.model())

    def test_snapshot_date_measure_collision_is_rejected(self):
        model = self.model()
        model["tables"][0]["measures"][0]["name"] = "Snapshot Date"
        with self.assertRaisesRegex(AssertionError, "Measure name collides with a column: Snapshot Date"):
            VALIDATION.validate_model_names(model)

    def test_case_insensitive_same_table_column_collision_is_rejected(self):
        model = self.model()
        model["tables"][0]["measures"][0]["name"] = "age BAND color"
        with self.assertRaisesRegex(AssertionError, "Measure name collides with a column"):
            VALIDATION.validate_model_names(model)

    def test_duplicate_measures_across_tables_are_rejected(self):
        model = self.model()
        existing = model["tables"][0]["measures"][0]
        model["tables"][1]["measures"] = [{**existing, "name": existing["name"].swapcase()}]
        with self.assertRaisesRegex(AssertionError, "Duplicate measure name"):
            VALIDATION.validate_model_names(model)

    def test_stale_unqualified_measure_reference_is_rejected(self):
        model = self.model()
        model["tables"][0]["measures"][0]["expression"] = "FORMAT([Snapshot Date], \"yyyy-MM-dd\")"
        with self.assertRaisesRegex(AssertionError, "Unknown DAX measure reference"):
            VALIDATION.validate_dax_references(model)

    def test_missing_qualified_dax_column_is_rejected(self):
        model = self.model()
        model["tables"][0]["measures"][0]["expression"] = "MAX('Snapshot'[Missing Date])"
        with self.assertRaisesRegex(AssertionError, "Unknown DAX column"):
            VALIDATION.validate_dax_references(model)

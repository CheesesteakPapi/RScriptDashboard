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

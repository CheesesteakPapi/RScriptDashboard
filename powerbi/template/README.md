# BWC Uncategorized Power BI template

Use [the project implementation guide](https://github.com/CheesesteakPapi/RScriptDashboard/blob/main/docs/implementation-guide.md) for the complete SharePoint, Power Automate, credential, and Power BI rollout.

Open **BWC Uncategorized.pbip** in a current Power BI Desktop release. Keep both adjacent artifact folders with it. Select **Refresh** to load the embedded synthetic data; this project contains definitions, without a cached data model.

The project contains three pages, 39 native visuals, three import tables, and 18 measures:

| Page | Contents |
| --- | --- |
| Overview | Total/critical/moderate/normal cards; component and AOR charts; oldest/average age; source rejections; scope and update watermark. |
| Remediation | Component, AOR, age-band and owner-badge slicers; evidence detail sorted oldest first; age colors and readable band labels; empty-selection message. |
| Data Quality | Rejection reasons and source records; published run identity, creation scope, refresh mode, state/acquisition counts, and update watermark. |

Component, AOR and age-band slicers are configured to synchronize between Overview and Remediation. Snapshot metadata remains independent of evidence filters. DataQuality records are loaded for the report audience; hiding a page does not secure its data. Publish this version only to the authorized remediation audience or remove RejectedRows and its visuals for a broader report.

Model measures use a **Report** prefix, such as `Report Snapshot Date`, to avoid colliding with source columns. Visual labels retain the reporting terminology. The workbook columns keep their existing source names.

**Normal: 0–14 calendar days since upload. Moderate: 15–29. Critical: 30+.** These are upload-age bands, not three-business-day compliance measures. Recording creation starts March 11, 2024.

## Inspect the sample

1. Extract the entire ZIP into a folder, or use this directory from the repository.
2. Open BWC Uncategorized.pbip. If Desktop presents a project/PBIR feature setting, enable the supported feature and reopen the project. An older or restricted Desktop version may need an update.
3. Select Refresh. No Axon or SharePoint credential is required while UseSampleData is true.
4. Verify 8 total, 4 critical, 2 moderate, 2 normal, and 3 rejected records. The source/snapshot date is October 13, 2026. Every page displays **SYNTHETIC DEMO DATA**.
5. Test component/AOR/band filters, detail sorting, synchronized slicers, and the empty-selection message.

The synthetic dates do not advance when the project is refreshed. They are a fixed acceptance fixture, not live evidence. The missing API watermark is labeled as unavailable.

## Connect the completed SharePoint workbook

In **Transform data → Manage parameters**, set:

| Parameter | Value |
| --- | --- |
| SharePointSiteUrl | The HTTPS site URL, such as https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE. No credentials or folder path. |
| ReportFolderPath | Library and reporting folder relative to that site, such as Shared Documents/BWC Reporting. |
| UseSampleData | false, after the completed latest workbook exists. |

The source expects **ReportFolderPath/latest/Uncategorized Report.xlsx**, with named tables **Uncategorized**, **Snapshot**, and **DataQuality**, produced by the existing Office Script. It reads the stable latest file, not every archived workbook. EvidenceState and the Excel summary tables are intentionally omitted from the Power BI model.

Choose the tenant's supported organizational SharePoint credentials, apply changes, and refresh. Keep all identifier columns as text. The Sample Data flag in the workbook controls the report's visible mode label; selecting the SharePoint source does not relabel a synthetic workbook as production. The source URL, library, credentials, workspace, and live refresh remain to be configured.

After publishing to the authorized Power BI workspace, configure cloud SharePoint source credentials and use the existing Power Automate refresh sequence. The recurring flow/refresh does not need the authoring desktop or a local file gateway. Verify the Power BI Run ID/Snapshot Date and update watermark against the published workbook after a cloud refresh with the desktop offline.

## Save a PBIX or reusable PBIT

In Desktop, use **File → Save As** and choose the **Power BI file (.pbix)** format to create a compiled report copy. For a reusable parameterized template, use Desktop's **Export → Power BI template (.pbit)** option. Keep the PBIP source project for future editing/version control. Never rename a ZIP or .pbip file to .pbix.

This cloud task generated and validated the source project; it did **not** open, refresh, render, or save it in Power BI Desktop. The first Desktop open validates native model loading, DAX execution, visual formatting, and slicer behavior. No report was published to a live account.

## Local validation and regeneration

From the repository root:

```bash
python3 scripts/build-powerbi-template.py
python3 scripts/validate-powerbi-template.py
node scripts/validate-powerquery.cjs /workspace/.bwc-powerquery-tools/node_modules/@microsoft/powerquery-parser
```

Regeneration uses the existing source rules and queries and the fixed synthetic CSV. It rewrites generated project/model/report definitions; preserve Desktop edits before running it. The structural validator checks required loader files (including `BWC Uncategorized.Report/definition/version.json`), model references, canvas bounds, sample labeling/counts, age bands, parameter defaults, and the disconnected metadata table. The M check parses all six repository queries and nine template expressions/partitions; it does not execute them.

Local verification also validated 48 project/report documents against [Microsoft's report/project schemas](https://github.com/microsoft/json-schemas) and the custom theme against the [August 2026 theme schema](https://github.com/microsoft/powerbi-desktop-samples/blob/main/Report%20Theme%20JSON%20Schema/reportThemeSchema-2.157.json). These are format checks, not a substitute for the first Desktop open.

## Update an earlier copy

If Desktop reports that version.json is missing, close the project, run `git pull` from your cloned repository, and reopen BWC Uncategorized.pbip. The corrected project includes `BWC Uncategorized.Report/definition/version.json`; its report-definition version is 2.0.0, distinct from the entry-point definition.pbir version. ZIP users should extract the corrected download into a new folder and keep both artifact folders beside the .pbip file.

If the semantic model reports that a measure cannot be created because a column has the same name, update the repository or extract the new model-fix ZIP into a fresh folder. The corrected model prefixes all measures with Report and updates DAX, visual, and formatting references together. Avoid fixing only Snapshot Date: other original measures had similar name overlaps.

# Cloud-only MVP setup

For the complete ordered walkthrough, use [the implementation guide](implementation-guide.md). This page remains the concise architecture/setup reference.

The production run uses **Power Automate cloud flows → Excel Online → SharePoint → Power BI Service**. No desktop scheduler, R installation, Python host, or Azure compute is required for the recurring run. Files in this repository are the preparation package; no flow, connection, or Power BI report has been deployed from this cloud task.

## Inputs still needed

1. Secure Axon credential connection, Reports.read confirmation, and expected row volume. Agency host/IDs were supplied privately; the approved recording-creation start is March 11, 2024. The supplied vendor documentation establishes Created and Updated endpoints; see `axon-api-integration.md`.
2. SharePoint site URL, document library, and report folder.
3. Power BI workspace and the tenant's supported report/model authoring path.

Provide locations and documentation, not passwords or tokens in chat. Authentication belongs in the organization's managed Power Automate connections. Use the appropriate commercial or government tenant services; do not assume a commercial endpoint from the product name.

The tenant must allow Office Scripts in Excel Online and the Power Automate Run script action. API HTTP/custom-connector actions commonly require Power Automate Premium; Power BI publishing/refresh and Power Query Online depend on the workspace's licenses/features. These entitlements have not been inspected here. The real export must fit Excel Online's script payload, execution, and row limits; a production-volume cloud run is part of acceptance.

## SharePoint layout

Under the chosen reporting folder, create:

```text
templates/report-template.xlsx
raw/YYYY-MM-DD/RUN-ID/evidence-api.json  # appended API acquisition history
raw/YYYY-MM-DD/RUN-ID/evidence.csv       # CSV alternative
raw/YYYY-MM-DD/RUN-ID/Uncategorized Report.xlsx
latest/Uncategorized Report.xlsx
latest/source_manifest.json         # used only by the direct CSV query route
```

Upload `automation/report-template.xlsx` into templates. It contains the named tables and is marked as demo data until the script populates it. Never publish an unprocessed template as a production report.

Each run receives its own raw API envelope (or CSV) and working workbook. Backfills copy the template; incremental runs copy the last published workbook and upsert its EvidenceState ledger. The `latest` workbook is updated only after processing succeeds. Preserve its SharePoint file identity by updating the existing file content on repeat runs; do not delete and recreate it. This gives the Power BI source a stable location and the archive a recoverable history.

## Install the Office Script in the cloud

In Excel for the web, open a workbook, use Automate → New Script, paste `automation/ProcessEvidence.office.ts`, and save it as **ProcessEvidence**. Install `automation/ReadRefreshState.office.ts` as **ReadRefreshState** to read the previous watermark from the working copy during incremental runs. The script is stored in Microsoft 365 and selected by the Excel Online connector. It makes no API requests and contains no credentials.

The script parameters are:

| Parameter | Value supplied by the flow |
| --- | --- |
| workbook/file | The new working copy for this run. |
| csvText | Complete canonical CSV, a complete Created page bundle, or the Created+Updated refresh envelope for incremental mode. |
| sourceFormat | `axon-refresh-bundle` for backfill/incremental API runs; `axon-page-bundle` for a complete Created-only snapshot; `csv` for exports. |
| snapshotDate | Reporting calendar date, `YYYY-MM-DD`. |
| runId | The unique flow run name, containing letters, digits, `_`, or `-`. |
| sourceDataDate | API extraction date if known; otherwise the empty string. |
| sampleData | `false` for production, `true` for the included test data. |

The return value contains run identity and aggregate counts. The workbook contains the details; the script does not return officer-level records to the flow output.

## Power Automate flow

Create a **scheduled cloud flow**. A reasonable initial schedule is 6:00 AM daily (or weekly) in **Eastern Standard Time** (Power Automate's zone includes daylight-saving transitions). Enable trigger concurrency control with degree **1** to prevent overlapping publications.

Build these actions in order:

1. **Recurrence.** Configure the cadence and reporting timezone.
2. **Compose — SnapshotDate.** Use:

   ```text
   formatDateTime(convertTimeZone(utcNow(), 'UTC', 'Eastern Standard Time'), 'yyyy-MM-dd')
   ```

3. **Compose — RunId.** Use:

   ```text
   workflow()['run']['name']
   ```

4. **Prepare the run and acquisition windows.** Follow `axon-api-integration.md`. Create the run folder, copy the template for initial/full reconciliation or copy latest for an incremental run, and use ReadRefreshState on the copy. Configure the confirmed start date (`2024-03-11`), the last successful watermark, and the overlap. Do not advance state in a separate file.
5. **Fetch complete Created and Updated reports.** POST the encoded token form, GET both page loops at at most 50 records, increment pageOffset by 1, and retain each successful empty terminal page. Validate with the separate Created/Updated schemas before field projection. Fail both retry/loop-limit errors. Save the completed refresh envelope as evidence-api.json in the run folder.
6. **Select the working workbook.** This is the new template copy for backfill or the copy of latest used to read the watermark for incremental mode. Never process latest in place. CSV mode continues to copy the template.
7. **Excel Online (Business) — Run script.** Select the SharePoint site/library, use the working workbook's file identifier from Create file, choose ProcessEvidence, and populate its parameters from the prior actions. If the connector reports a transient file-availability/lock error, use its supported retry policy. Do not publish until Run script completes successfully.
8. **Check the returned run ID and snapshot date.** The source-quality count is returned as `rejected_rows`; the workbook's Data Quality table explains exclusions. For a strict deployment, terminate before publication when that count is nonzero. Do not interpret a successful run with rejected records as a clean source.
9. **Get file content — completed working workbook.** Update `latest/Uncategorized Report.xlsx` with these bytes. On the first run only, create the destination file. A specific file-not-found result can take the create branch; authorization or other errors must fail the publication.
10. **Record successful publication and refresh the report.** Use the workspace's supported Power BI refresh connection/process. Do not request refresh from the flow's failure branch.

Enable secure inputs/outputs for actions holding API authentication or the source contents. Keep the reporting folder and report audience appropriate for the owner-level data. A SharePoint source permission is not automatically a Power BI row-level access rule.

The flow uses supported connector actions and expressions above, but is **not an importable Power Automate package** yet. The API and tenant-specific connection references are required to create and verify a real flow.

## Power BI source and report

Use the stable completed workbook at `latest/Uncategorized Report.xlsx`. Select its **Uncategorized** and **Snapshot** named tables; load **DataQuality** only for users who need remediation detail. EvidenceState is a processor ledger and is not loaded into the report. The other summary tables are convenient Excel views and should not be appended into the detail fact table.

For Power Query Online, create these queries with the exact names:

1. **ReportSource**: paste `powerbi/ReportSourceExcel.pq`, set the site URL and full reporting-folder URL, and disable load.
2. **Uncategorized**: paste `powerbi/Uncategorized.pq`; enable load.
3. **Snapshot**: paste `powerbi/Snapshot.pq`; enable load.
4. **RejectedRows**: paste `powerbi/RejectedRows.pq` if required; enable load.

Use your workspace's supported cloud semantic-model authoring/import path for these tables or the SharePoint workbook. That path and the actual available UI/features must be confirmed in the selected tenant. A dataflow alone is not a report or semantic model; publishing it does not complete dashboard deployment.

Create the measures in `powerbi/measures.dax` individually. Keep Snapshot disconnected from Uncategorized, sort Age Band by Age Band Order, and set badge/evidence/device identifiers to text. Snapshot and upload dates must be date types, and upload-age fields must be numeric.

Suggested report pages:

| Page | Contents |
| --- | --- |
| Overview | Total, critical, moderate, and normal cards; component/AOR bars; Snapshot Date, Source Data Date, creation-date scope, Updated Through UTC, Sample Data status, and rejected count. |
| Remediation | Filterable detail table sorted by Days Since Upload descending; component, AOR, and age-band slicers; age colors plus readable band labels. |
| Owner / quality | Owner counts grouped by badge, names, organization, and role; rejected-record reasons for the authorized audience. |

Power BI Service refresh must use cloud SharePoint credentials, not a synchronized local folder or on-premises gateway. When using a dataflow, complete its refresh before refreshing its downstream semantic model. When using a SharePoint/OneDrive workbook import, file synchronization and semantic-model refresh are separate operations; a refresh request alone does not prove the updated workbook was ingested. Verify the report's **Run ID/Snapshot Date** against the completed flow after the first run. If using separate schedules initially, display freshness and monitor failures; a time offset alone is not a dependency guarantee.

## CSV alternative in the same cloud tools

If the API can supply or Power Automate can construct the canonical CSV, the flow can publish that raw CSV and then update `latest/source_manifest.json`. Use `automation/source_manifest.schema.json` and the clearly marked example. The relative folder identifies an immutable completed run. Update the manifest only after the CSV upload succeeds.

In Power Query Online, use `fnProcessEvidence.pq` as a nonloaded function and `ReportSource.pq` as the nonloaded staging query, then the same loaded Uncategorized/Snapshot/RejectedRows queries. This moves transformation into Power Query Online and does not require the Office Script. Do not load both source strategies into the same model. The raw CSV query is syntax-checked here; its actual runtime and tenant connections still need cloud verification.

## Acceptance before calling it deployed

- Run the provided synthetic CSV through the **cloud** Office Script and verify `examples/expected-summary.json`: 8 total, 2 normal, 2 moderate, 4 critical, and 3 rejected records.
- Test an empty eligible dataset, the 14/15/29/30 boundaries, a conflicting duplicate, a failed source request, and a failed processing action. A failed run must retain the prior published workbook.
- Run the actual tenant's Created and Updated endpoints end to end, including both empty terminal pages. Test a category-only change, status deletion, category removal, a newly uploaded older recording, overlap replay, missed/failed scheduled runs, and periodic full reconciliation. Check that only a successful latest-workbook publication advances the watermark. Confirm creation-date boundary behavior, field types, and owner-group ordering against the current manual export. Reconcile counts and inspect a representative source record at each age boundary.
- Reopen the exact Power BI report after refresh; confirm its run ID/date, measures, slicers, empty state, and detail row reconciliation. Verify this with the submitting desktop offline.

Local verification completed in this repository does not substitute for those connection/tenant acceptance checks. The [Power BI browser skill](skill://Plugin_52b7f269362c819190348f32a2f9e7a9/power-bi/SKILL.md) states that “cloud-backed tasks are not supported for live account access”; this Codex cloud task cannot perform its browser-based account deployment. That restriction affects authoring/access from this task, not the desktop-free scheduled architecture.

## Local verification tools

Python:

```bash
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests -v
python3 -m bwc_report --input examples/evidence.sample.csv --as-of 2026-10-13 \
  --source-date 2026-10-13 --sample --xlsx --output output/demo
```

Optional Node tooling (keep dependencies outside the checkout):

```bash
npm --cache /workspace/.bwc-powerquery-tools/npm-cache install \
  --prefix /workspace/.bwc-powerquery-tools --no-audit --no-fund \
  @microsoft/powerquery-parser@2.0.0 typescript@5.9.3
node scripts/validate-powerquery.cjs /workspace/.bwc-powerquery-tools/node_modules/@microsoft/powerquery-parser
node scripts/test-office-script.cjs /workspace/.bwc-powerquery-tools/node_modules/typescript
```

The Office Script checks execute its transformation and workbook calls against a local workbook test double; the M checks parse syntax with Microsoft's parser. Neither test establishes a successful Office Scripts/Power BI Service deployment.

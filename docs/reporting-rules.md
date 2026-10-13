# Reporting rules and data contract

The business requirements come from the user-supplied **ICE BWC Uncategorized Report Script Analysis**. The subsequently supplied Axon API documents establish the EvidenceCreated reporting contract and mapping described in `axon-api-integration.md`. The original R Markdown source and a production export/API response were not supplied. This implementation translates those requirements and verifies the rules with synthetic data; it is not a byte-for-byte port of an inspected R program.

## Decisions

| Rule | MVP behavior |
| --- | --- |
| Critical boundary | User selected **30 or more** days; all detail, summary, and formatting rules agree. |
| Moderate boundary | 15–29 days. |
| Normal boundary | 0–14 days, including uploads on the snapshot date. |
| Age calculation | Snapshot calendar date minus the first ten characters of the vendor upload date. No absolute value. |
| Business-day policy | Not calculated. Weekends, holidays, deadline start/cutoff, and policy applicability need authoritative definitions. |
| Fiscal year | October 1 rollover, calculated directly instead of adding 92 days. |
| Eligible statuses | Active and Queued for Deletion, case-insensitive. |
| Categories | Empty, whitespace, or standard null markers mean uncategorized. |
| Evidence types | Retain all types, matching the described source filters. The measure is named **items**. A video-only restriction needs the actual vendor type values. |
| Blank rows | Drop rows whose cells are all empty/null. Keep the last valid row. |
| Duplicate IDs | Collapse identical records. Conflicting records with the same ID fail the run before publication. |
| Missing ID / invalid upload / future upload | Exclude into a remediation table; report the rejected count. |
| Missing groups | Retain as Unassigned in every total. |
| Unknown component | Retain as Other, with the actual organization name and a quality note. |
| Officer grouping | Badge, name, role, component, organization, and AOR together; never attach the first matching name to all badge records. |
| Timestamp timezone | Preserve the vendor's exported calendar date, as in the supplied process. Changing that convention needs the actual API timestamp contract. |

## Source columns

Required: `Evidence ID`, `Categories`, `Status`, `Date Uploaded`, `Owner Groups`.

Optional: `Evidence Serial Number`, `Evidence Type`, `Owner Badge ID`, `Owner First Name`, `Owner Last Name`, `Owner Role`, `Serial Number`, `Created Date (Record Start)`, `External Evidence ID`.

For API input, Evidence ID is the documented unique internal `evidenceId`, and External Evidence ID preserves `idExternal`. The report schema does not document an evidence-serial field; leave that optional field blank rather than substituting a different identifier. The creation-date window is recorded in Snapshot and must be approved independently of upload-age thresholds.

Read IDs and badges as **text** to preserve leading zeroes. UTF-8 CSV with comma delimiters and standard CSV quoting is the common exchange format. Translate actual API JSON field names into these headers in Power Automate after reviewing the endpoint documentation. If the API returns an export job, poll that job; if it returns pages, retrieve every page before treating the dataset as a snapshot.

Component derivation uses the primary group before the first comma, removes `Users` and `2nd Line Sup`, and normalizes whitespace. Recognized components are HSI, ERO, FLETC, FOIA, OPR, and OFTP. HSI/ERO organization prefixes become AOR in the geographic field. OPR/OFTP keep their full organizational names in Component Name. Unknown and unassigned groups are retained.

## Grain and consistency

`Uncategorized`: one row per valid, eligible, uncategorized evidence ID for the current snapshot. `Snapshot`: one row even when there are no uncategorized items. `DataQuality`: rejected eligible source records with a source record number and reason.

The workbook's AOR, component, and owner summaries are convenient views of the same detail records. Do not append them to the detail table or count them as additional evidence. Power BI should calculate its filter-responsive measures from Uncategorized. The Snapshot table is disconnected metadata and source-quality information.

Row reconciliation:

```text
Input rows = uncategorized detail rows + identical duplicates removed
           + excluded-status rows + categorized rows + rejected rows
Normal + Moderate + Critical = uncategorized detail rows
```

The original 16-sheet design becomes a seven-sheet workbook: Instructions, Uncategorized, AOR Summary, Component Summary, Owner Summary, Snapshot, and Data Quality. Component and age slices are filters in Power BI. Nothing is omitted from detail totals because it lacks a dedicated component sheet.

Snapshot date means the date used for the age calculation. Source Data Date means the API/export's known extraction date; leave it blank when unknown. Do not substitute the flow run date for an unknown extraction date. A daily archive is evidence of observed snapshots, not proof of when an item was ultimately categorized.

Future storage can use SharePoint lists or Dataverse with a separate snapshot record and `(Snapshot Date, Evidence ID)` detail key. A current-state migration must remove or resolve items that disappear from the uncategorized snapshot; simple append-only imports will overstate the backlog.

## Confirmed incremental scope

Recording creation starts March 11, 2024. Daily or weekly runs append immutable raw response/workbook history and upsert current state by internal Evidence ID. Created and Updated responses have different category formats; the Office Script normalizes both before filtering. Retain all statuses and category assignments in EvidenceState, then derive the current backlog and recalculate every record's calendar age. Incremental windows use the last published UTC watermark with overlap, not the maximum dateModified from returned rows. A periodic complete reconciliation replaces the ledger to repair missed updates or disappeared evidence. Archived detail snapshots must not be appended into the current Power BI fact table.

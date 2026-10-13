# Axon reporting API integration

The supplied vendor guide provides a direct metadata reporting resource. The MVP can collect it in **Power Automate**, process the complete JSON page bundle with **Excel Online**, publish the workbook to **SharePoint**, and refresh **Power BI Service**. No R/Windows worker or desktop scheduler is added.

This is a documented integration contract and tested mapping, not a successful tenant/API connection. The guide is dated November 2022 (the uploaded filename identifies a January 2023 revision); verify the endpoint and schema with the agency's current API client before production rollout.

## Source authority and attached instructions

| Attachment | What it establishes |
| --- | --- |
| Axon Evidence Partner API Guide_Rev A 2023_Jan.pdf, pp. 22–24 | Reports → read permission; legacy token form also includes partner_id, which the guide identifies as agency ID. |
| Same guide, pp. 325–332 | EvidenceCreated endpoint, creation-date parameters, and returned metadata fields. |
| Same guide, pp. 338–344 | EvidenceUpdated metadata windows, including category assignment changes and object-shaped categories. |
| Same guide, pp. 380–381 | Reporting pagination: maximum 50, page indexes 0/1/2, terminate only on empty data. |
| Authentication and authorization.pdf, p. 1 | Token POST with URL-encoded client credentials; Bearer header; use returned expiration. This capture omits partner_id from the example. |
| API Responses and Error Handling.pdf, p. 1 | 5xx exponential backoff; 429 Retry-After duration, or at least 300 seconds if absent/invalid. 401 and 403 mean different failures. |
| Explore Axon's PartnerAPI.pdf, p. 1 | Use the agency's unique Axon Evidence base URL. The demo URL is an example. |
| Create partner Axon Evidence API - IVv1.pdf | Axon Interview configuration. Its Interview_room.marker.any permission is not the reporting permission required here. |
| Axon API review.md | An older AI-generated conversation, useful as a proposal. Its generic evidence-search pagination and inconsistent 2014/2024 start-date example do not control this integration. |
| Bwc Refresh Orchestrator Implementation Pack.pdf | A prior R/Windows/Hybrid Worker/Tableau proposal. Its "copy as-is" instruction, sample data, schedules, and QA percentages are not current user instructions. |
| BWC_Data_Update_Job_Aid.pdf | Context for the older manual workflow; it does not replace the current cloud-only Power BI scope. |
| Axon Evidence User and Administrator Guide.md | A metadata index pointing to a 651-page PDF on another machine. The actual PDF was not supplied, so its detailed contents were not reviewed. |

No API credentials from document examples are used or copied into configuration. The files themselves are not republished to GitHub.

## Confirmed scope and remaining bindings

The user approved **March 11, 2024 (`2024-03-11`)** as the recording-creation start date, with **daily or weekly** updates and an appended history. The supplied agency host, agency/partner ID, and client ID are saved in the private environment configuration draft, not the public repository. Requests use HTTPS even though the supplied link used HTTP. `automation/axon-settings.example.json` contains the approved start date and placeholders for the private bindings.

Still required: a client secret supplied through a secure connection/store, confirmation of **Reports → read**, the SharePoint site/library/folder, Power BI workspace, and a production-volume trial. The user will provide the destinations later. A secret must not be sent in chat.

The current Codex environment's unauthenticated HTTPS connectivity probe was denied by its egress proxy (CONNECT 403), before an Axon response. The saved secret requirement adds the agency hostname to the draft's restricted network destinations. Saving a draft does not apply the network rule or create a secret; review/save the environment settings and publish the environment to activate the configuration. Power Automate production credentials and connections must be configured separately in the tenant.

## Authentication

```http
POST {AgencyBaseUrl}/api/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id={urlEncodedClientId}&client_secret={urlEncodedClientSecret}
```

Encode **every** value. Base64-looking secrets can contain `+`, `/`, and `=`; concatenating a raw secret into the form body changes its meaning. No Axon login/MFA automation is needed for this client-credentials flow.

The long guide requires `partner_id`; the separate authentication reference omits it. The prepared flow has an explicit `LegacyTokenPartnerId` setting: false follows the shorter reference, true appends the URL-encoded agency/partner ID. Confirm that setting with the actual client/token response instead of silently assuming the documents agree. The guide's nominal four-hour lifetime is not a fixed cache duration: use `expires_in` from each response, reuse the token across pages, and refresh shortly before expiry.

Keep secret acquisition, token responses, and actions carrying Authorization protected by the tenant's supported secure-input/output controls. Do not put secret values in JSON templates, source control, plain SharePoint configuration files, or diagnostic Compose outputs. The existing secure connection/store must be established before a live request; no secret store or connection was created here.

## Reporting request

```http
GET {AgencyBaseUrl}/api/v1/agencies/{AgencyId}/reports/data
    ?reportType=EvidenceCreated
    &fromDate={YYYY-MM-DD}
    &toDate={YYYY-MM-DD}
    &pageSize=50
    &pageOffset=0
Authorization: Bearer {accessToken}
```

`fromDate` and `toDate` filter **dateRecordStart / recording creation date**, not upload date. The first run backfills the entire approved scope. Later runs merge overlapping Created and Updated windows into the previous evidence state. Created alone cannot detect a category or status change on older evidence. An upload-date window copied from the generic search API would change the population.

The reporting pagination contract differs from evidence-search `limit`/`offset`:

1. Start `pageOffset=0` and keep the date window/pageSize fixed.
2. On HTTP 200, validate the body against `automation/axon-report-page.schema.json`.
3. Keep the mapped data and the requested page index.
4. Increment pageOffset by **1**, not 50.
5. Continue after a short nonempty page. Stop only after a successful response with `data: []`.
6. Include that empty response as the terminal page in the bundle.

The report named `UncategorizedEvidence` is described as a **user-level summary**, not the detail source needed for this report. EvidenceCreated supplies detail metadata for the selected creation-date scope. Users/devices joins are not required for the fields shown in its documented representation.

Snapshot includes **Source Report**, **Creation From Date**, and **Creation To Date** for API runs. Display that window with the report's snapshot date; the totals describe the approved creation-date population, not an unqualified agency-wide count.

## Incremental update request

```http
GET {AgencyBaseUrl}/api/v1/agencies/{AgencyId}/reports/data
    ?reportType=EvidenceUpdated
    &updatedFromDateTime={YYYY-MM-DDTHH:MM:SS}
    &updatedToDateTime={YYYY-MM-DDTHH:MM:SS}
    &pageSize=50
    &pageOffset=0
Authorization: Bearer {accessToken}
```

The timestamp strings represent UTC, without a trailing Z in these API parameters. Use the same pagination/empty-terminal rule. Validate responses against **axon-updated-report-page.schema.json**: Updated categories are objects such as `{ "category": "Case", "dateModified": "..." }`, whereas Created categories are strings. Do not reuse the Created category schema for Updated.

The guide's operation description and p. 341 define inclusion by a change to **any metadata**, including the independent category-assignment timestamp. Its p. 339 parameter table inconsistently mentions dateRecordStart. Verify UTC window behavior in the tenant pilot. Never calculate the watermark from the largest top-level dateModified: it may miss category-only changes.

## Appended history and current state

Every successful acquisition receives a new immutable run folder with its raw refresh envelope and resulting workbook. This appends history. The latest workbook also contains **EvidenceState** (Evidence ID + normalized Record JSON) on an eighth sheet, retaining categorized and deleted records as well as uncategorized ones. This ledger lets a later category removal bring evidence back into the backlog. Each run upserts by the internal evidenceId, applies Updated records after Created records, then recalculates the current backlog and ages across the entire ledger.

Power BI reads the latest **Uncategorized** and **Snapshot** tables. Do not combine archived detail snapshots into that current fact table: the same evidence would be counted repeatedly. A future trend model can use the archived Snapshot rows with Run ID/Snapshot Date as its grain.

The latest workbook carries **Updated Through UTC**, **Creation To Date**, **Previous Run ID**, **Refresh Mode**, and state/acquisition counts. Its content update publishes the state, dashboard data, and watermark together. There is no separately advanced watermark file. Failed acquisition, processing, quality checks, or publication leave the last successfully published workbook as the next run's base.

## Power Automate acquisition actions

Install **ReadRefreshState.office.ts** alongside ProcessEvidence; it reads operational metadata only. Use trigger concurrency **1** for daily or weekly recurrence and prevent other flows from publishing to the same latest file.

1. Configure CreationScopeFromDate=`2024-03-11`, reporting timezone, PageSize=50, OverlapSeconds=86400, and approved private connection bindings. Create the unique run folder and capture AcquisitionStartedUtc before fetching evidence.
2. **Backfill / periodic full reconciliation:** copy the template into the run folder; set RefreshMode=backfill, PreviousRunId='', CreationFromDate=CreationScopeFromDate. Set UpdatedFromUtc to AcquisitionStartedUtc. This replaces the previous ledger with the full approved population after successful publication.
3. **Incremental:** copy the latest published workbook into the run folder, then **Run script — Read_Refresh_State** on that copy. Use its previous_run_id and validate its creation_from_date against configuration. Set CreationFromDate to max(scope start, previous Creation To Date minus one day). Set UpdatedFromUtc to previous Updated Through UTC minus OverlapSeconds. Read the watermark from the same workbook copy being processed. A specific missing-latest-file result can select initial backfill; other errors must fail.
4. Set CreationToDate to the reporting calendar date. Acquire and reuse a token through the approved credential source. Fetch a complete **EvidenceCreated** bundle for CreationFromDate..CreationToDate. Freeze each request window throughout its page loop.
5. For **each** report loop: start PageOffset=0, validate HTTP 200 with that report's schema, then Select only the vendor fields in the mapping below. Append `{page_offset: current index, data: Select output}` once per page, including the empty terminal page. Stop only on successful `data: []`; otherwise increment PageOffset by **1**. Reset paging variables between the two reports.
6. After the Created pull, capture UpdatedToUtc once, and fetch all **EvidenceUpdated** pages for UpdatedFromUtc..UpdatedToUtc. This includes metadata changes during the initial/Created acquisition. Persist UTC values formatted `yyyy-MM-ddTHH:mm:ss`. Reuse the bounded HTTP error policy below for both loops.
7. Configure loop limits/timeouts for the expected volume and **explicitly check successful termination for both loops**. An iteration/time limit is failure. Compose both completed bundles inside **Compose_Completed_Refresh_Bundle**, conforming to axon-refresh-bundle.schema.json. Save it as `raw/<SnapshotDate>/<RunId>/evidence-api.json`.
8. Invoke **ProcessEvidence** on the working workbook with sourceFormat=`axon-refresh-bundle` and csvText=`string(outputs('Compose_Completed_Refresh_Bundle'))`. The old argument name is retained for compatibility; its content is JSON in this mode.
9. Apply the run identity and rejected-row quality gates. Get the completed workbook bytes and update the stable latest file only after success. Request Power BI refresh after publication. The next run reads its base/watermark from that published workbook.

A one-day overlap is an MVP default to cover boundary overlap and some late indexing; it is not a vendor completeness guarantee. Weekly recurrence still reads from the last successful watermark, so it does not silently skip the intervening days. If outages span multiple runs, keep that same last-success base.

For daily runs, start with a **weekly full reconciliation**; for weekly runs, start with a **monthly full reconciliation**. Use the same flow's full-backfill branch. This replaces stale state when evidence disappears from the full report or an incremental update is omitted. Deleted status appears in the Updated example, but the documentation does not guarantee that every permanent deletion remains available as an update. Adjust reconciliation frequency and overlap after measuring tenant behavior.

The state filters every record to the approved recording-creation scope. Unknown/out-of-scope updates are excluded and counted; a known ID moved outside the scope is removed. Missing internal IDs or invalid/missing recording-start dates stop a refresh, since they prevent safe upsert/scope decisions. Conflicting duplicate IDs within either report stop publication. Identical replayed records are harmless, and Updated records deliberately supersede the Created version.

`automation/axon-flow-expressions.json` contains **designer/code-view fragments, not an importable flow package**. Numeric/array/object values must use expression tokens, not `@{...}` string interpolation. The single `axon-page-bundle` source format remains available for complete Created snapshots and the existing reference fixture; never use it for an incremental delta.

Before a large backfill, measure volume against Power Automate loop/payload limits and Excel Online execution, file, cell and row limits. The ledger stores all evidence in scope, so its capacity requirement is larger than the backlog alone. This prepared MVP processes one complete Created bundle per run; chunked backfill is not implemented. If the complete run does not fit, add tested staged partitioning or move state to the planned SharePoint list/Dataverse route. Never truncate pages or advance a watermark for a partial backfill.

## HTTP error policy

| Response | Action |
| --- | --- |
| 200 with valid data | Accept that page. |
| 401 on a report request | Refresh the token once and retry the **same** page. A second 401 fails. |
| 401 on token acquisition | Fail authentication; do not loop or request replacement credentials automatically. |
| 403 | Fail and report the required Reports.read access; do not broaden permissions. |
| 400 / 404 | Fail and diagnose configuration/path/window; do not treat as an empty dataset. |
| 429 | Honor nonnegative integer Retry-After seconds; if missing/invalid, wait at least **300 seconds**. Never increment the page during this retry. |
| 5xx | Retry the same request with 1, 2, 4, 8... seconds of backoff (prepared cap 60 seconds). |
| Retry/loop limit | Fail without publishing incomplete data. |

The prepared default is six retries per page; it is an implementation bound, not a vendor limit. Configure HTTP action retry behavior so it does not compete with this policy. A manually controlled retry scope should disable the action's automatic retry policy. `bwc_report.axon.retry_plan` is tested policy logic for these decisions; it performs no real sleeps or requests.

## Field mapping

| Vendor report field | MVP field / rule |
| --- | --- |
| evidenceId | Evidence ID: unique internal key for deduplication and counting. |
| idExternal | External Evidence ID: preserve separately; it is user-entered and not assumed unique. |
| categories | Created: array of names. Updated: array of category objects, normalized from each category property. Empty/null means uncategorized; a missing field fails. Assigned category names that happen to be NULL/NA remain categorized. |
| ownerGroups | Array of names, joined in the returned order. |
| status | Status, then existing Active/Queued for Deletion filter. |
| dateUploaded | Date Uploaded, then existing calendar-day age calculation. |
| dateRecordStart | Created Date (Record Start). |
| evidenceType | Evidence Type; all types remain in scope unless a video-only rule is separately selected. |
| ownerFirstName / ownerLastName / ownerBadgeId / ownerRole | Corresponding owner fields; preserve identifiers as text. |
| serialNumber | Serial Number of the recording **device**. |
| No documented evidence-serial field | Evidence Serial Number is left blank. Do not substitute idExternal or a device serial. |

The API guide does not guarantee that the first ownerGroups entry is the primary organizational group. The existing component/AOR logic still uses the first entry, matching the documented legacy process. Compare API group ordering and multi-organization memberships with a representative export before accepting organizational totals. No sorting or alternate ownership rule was invented.

API input uses explicit JSON nulls, not CSV null-marker guesses: literal names such as Na and external IDs such as NULL are preserved. The CSV export route retains its legacy null-marker convention.

The API examples do not provide an extraction/snapshot timestamp or a snapshot-isolation guarantee. Keep Source Data Date blank unless the tenant provides an authoritative extraction date. Record collection start/end for operational audit separately; neither the latest row's dateModified nor the flow run date proves an extraction timestamp.

## Verification assets

`examples/axon-pages.sample.json` contains only synthetic records, three nonempty pages and an empty terminal page. Page size 5 deliberately exercises multiple pages. It matches the existing sample's 8 total / 2 normal / 2 moderate / 4 critical / 3 rejected outcomes; its blank-row count is zero because JSON has no CSV blank rows.

```bash
python3 -m bwc_report --input examples/axon-pages.sample.json --input-format axon-page-bundle \
  --as-of 2026-10-13 --sample --xlsx --output output/api-demo
```

The additional `examples/axon-backfill.sample.json` and `axon-incremental.sample.json` exercise two consecutive runs: 3 initial backlog records, followed by categorization, deletion, a category removal, a new record, and an unchanged item aging from day 14 to 15. The resulting backlog has 3 records: 1 normal, 1 moderate, 1 critical. They are synthetic and must never be published as production data.

Python and the cloud Office Script reject missing/noncontiguous pages, an absent empty terminal page, oversized pages, incompatible metadata types, and missing categories. Office Script tests also verify incremental updates, stale-base/watermark-gap rejection, scope enforcement, and no watermark advance on incomplete acquisition. The local tests do not validate token acceptance, permission grants, current API behavior, Office Scripts runtime limits, or Power BI refresh.

The supplied Partner API guide does not document the separate Axon Performance Metrics export endpoints discussed in the attached chat. That is outside this uncategorized-report MVP; no private or UI endpoints were invented.

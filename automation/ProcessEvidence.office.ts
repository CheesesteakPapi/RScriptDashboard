/** Run in Excel Online through Power Automate's Run script action.
 * Run against a NEW COPY of the template (backfill) or latest workbook (incremental).
 * Publish only after success; the working copy carries its own state and watermark.
 * No network calls, R runtime, desktop process, or embedded credentials.
 */
type CellValue = string | number | boolean;
interface DataRow { [key: string]: CellValue; }
interface SourceRow { [key: string]: string; }
interface AxonRecord {
  evidenceId: string | null;
  status: string | null;
  dateUploaded: string | null;
  ownerGroups: string[] | null;
  categories: (string | { category: string; dateModified?: string | null })[] | null;
  idExternal?: string | null;
  evidenceType?: string | null;
  ownerBadgeId?: string | null;
  ownerFirstName?: string | null;
  ownerLastName?: string | null;
  ownerRole?: string | null;
  serialNumber?: string | null;
  dateRecordStart?: string | null;
}
interface AxonPage { page_offset: number; data: AxonRecord[]; }
interface AxonBundle {
  schema_version: number;
  report_type: string;
  from_date?: string;
  to_date?: string;
  updated_from_datetime?: string;
  updated_to_datetime?: string;
  page_size: number;
  sample_data?: boolean;
  pages: AxonPage[];
}
interface AxonRefresh {
  schema_version: number;
  mode: string;
  previous_run_id: string;
  creation_from_date: string;
  creation_to_date: string;
  created: AxonBundle;
  updated: AxonBundle;
  sample_data?: boolean;
}
interface ReconciledState { rows: SourceRow[]; metadata: DataRow; }
const axonFields = ["Evidence ID", "Categories", "Status", "Date Uploaded", "Owner Groups",
  "Evidence Serial Number", "Evidence Type", "Owner Badge ID", "Owner First Name", "Owner Last Name",
  "Owner Role", "Serial Number", "Created Date (Record Start)", "External Evidence ID"];
interface ScriptResult {
  run_id: string;
  snapshot_date: string;
  total_uncategorized: number;
  normal: number;
  moderate: number;
  critical: number;
  rejected_rows: number;
  sample_data: boolean;
}

function main(workbook: ExcelScript.Workbook, csvText: string,
  snapshotDate: string, runId: string, sourceDataDate: string = "",
  sampleData: boolean = false, sourceFormat: string = "csv"): ScriptResult {
  let creationFromDate = "", creationToDate = "";
  let state: ReconciledState | undefined;
  if (sourceFormat === "axon-refresh-bundle") {
    const refresh = JSON.parse(csvText) as AxonRefresh;
    state = reconcileAxon(workbook, refresh);
    csvText = sourceRowsCsv(state.rows);
    creationFromDate = refresh.creation_from_date;
    creationToDate = refresh.creation_to_date;
    if (state.metadata["Sample Data"] === true) sampleData = true;
  }
  else if (sourceFormat === "axon-page-bundle") {
    const bundle = JSON.parse(csvText) as AxonBundle;
    csvText = axonBundleCsv(bundle);
    creationFromDate = bundle.from_date || "";
    creationToDate = bundle.to_date || "";
    if (bundle.sample_data === true) sampleData = true;
  } else if (sourceFormat !== "csv") {
    throw new Error("Source format must be csv, axon-page-bundle, or axon-refresh-bundle.");
  }
  const required = ["Evidence ID", "Categories", "Status", "Date Uploaded", "Owner Groups"];
  const optional = ["Evidence Serial Number", "Evidence Type", "Owner Badge ID", "Owner First Name",
    "Owner Last Name", "Owner Role", "Serial Number", "Created Date (Record Start)", "External Evidence ID"];
  const known = required.concat(optional);
  const normalize = (value: string): string => sourceFormat !== "csv" ? value.trim() : clean(value);
  const details: DataRow[] = [];
  const rejected: DataRow[] = [];
  const counts: DataRow = { "Input Rows": 0, "Blank Rows Removed": 0, "Duplicate Rows Removed": 0,
    "Excluded Status Rows": 0, "Categorized Rows": 0, "Rejected Rows": 0 };
  const snapshotTime = parseDay(snapshotDate);
  if (snapshotTime === null || snapshotDate.length !== 10 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("Provide an ISO snapshot date and a nonempty safe run ID.");
  }
  if (sourceDataDate !== "" && (sourceDataDate.length !== 10 || parseDay(sourceDataDate) === null)) {
    throw new Error("Source data date must be blank or an ISO date.");
  }
  const fy = Number(snapshotDate.slice(0, 4)) + (Number(snapshotDate.slice(5, 7)) >= 10 ? 1 : 0);
  const records = parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (records.length === 0) throw new Error("Source CSV has no header.");
  const headers = records[0].map(value => value.trim());
  if (new Set(headers).size !== headers.length || headers.some(value => value === "")) {
    throw new Error("Source CSV has duplicate or blank column names.");
  }
  const missing = required.filter(name => !headers.includes(name));
  if (missing.length > 0) throw new Error("Missing required columns: " + missing.join(", "));
  const seen = new Map<string, string>();
  for (let index = 1; index < records.length; index++) {
    const cells = records[index];
    if (cells.every(value => normalize(value) === "")) {
      counts["Blank Rows Removed"] = Number(counts["Blank Rows Removed"]) + 1;
      continue;
    }
    if (cells.length !== headers.length) throw new Error(`CSV record ${index + 1} has the wrong number of cells.`);
    counts["Input Rows"] = Number(counts["Input Rows"]) + 1;
    const source: SourceRow = {};
    known.forEach(name => {
      const position = headers.indexOf(name);
      source[name] = position < 0 ? "" : normalize(cells[position]);
    });
    const id = source["Evidence ID"];
    const signature = JSON.stringify(known.map(name => source[name]));
    if (id !== "" && seen.has(id)) {
      if (seen.get(id) !== signature) throw new Error("Conflicting duplicate evidence IDs; publishing stopped.");
      counts["Duplicate Rows Removed"] = Number(counts["Duplicate Rows Removed"]) + 1;
      continue;
    }
    if (id !== "") seen.set(id, signature);
    if (!["active", "queued for deletion"].includes(source["Status"].toLowerCase())) {
      counts["Excluded Status Rows"] = Number(counts["Excluded Status Rows"]) + 1;
      continue;
    }
    if (source["Categories"] !== "") {
      counts["Categorized Rows"] = Number(counts["Categorized Rows"]) + 1;
      continue;
    }
    const uploadTime = parseDay(source["Date Uploaded"]);
    const reason = id === "" ? "Missing evidence ID" : uploadTime === null ? "Missing or invalid upload date"
      : uploadTime > snapshotTime ? "Upload date is after snapshot date" : "";
    if (reason !== "") {
      rejected.push({ "Source Row": index + 1, "Evidence ID": id, "Date Uploaded": source["Date Uploaded"], "Reason": reason });
      counts["Rejected Rows"] = Number(counts["Rejected Rows"]) + 1;
      continue;
    }
    if (uploadTime === null) throw new Error("Unexpected invalid upload date.");
    const days = Math.round((snapshotTime - uploadTime) / 86400000);
    const band = days >= 30 ? "Critical" : days >= 15 ? "Moderate" : "Normal";
    const org = organization(source["Owner Groups"]);
    const createdTime = parseDay(source["Created Date (Record Start)"]);
    const notes: string[] = [];
    if (source["Created Date (Record Start)"] !== "" && createdTime === null) notes.push("Invalid created date");
    if (createdTime !== null && createdTime > uploadTime) notes.push("Created date is after upload date");
    if (source["Owner Badge ID"] === "") notes.push("Missing owner badge ID");
    if (org["Component"] === "Other") notes.push("Unrecognized component");
    const detail: DataRow = {};
    optional.forEach(name => { detail[name] = source[name]; });
    Object.assign(detail, org, {
      "Run ID": runId, "Snapshot Date": snapshotDate, "Fiscal Year": fy, "Evidence ID": id,
      "Days Since Upload": days, "Age Band": band, "Age Band Order": band === "Critical" ? 3 : band === "Moderate" ? 2 : 1,
      "Age Band Color": band === "Critical" ? "#C41230" : band === "Moderate" ? "#FFA500" : "#FFFF00",
      "Status": source["Status"], "Owner Groups": source["Owner Groups"],
      "Date Uploaded": source["Date Uploaded"].slice(0, 10),
      "Created Date (Record Start)": createdTime === null ? "" : source["Created Date (Record Start)"].slice(0, 10),
      "Days Between Create and Upload Date": createdTime !== null && createdTime <= uploadTime
        ? Math.round((uploadTime - createdTime) / 86400000) : "",
      "Data Quality Notes": notes.join("; ")
    });
    details.push(detail);
  }
  details.sort((a, b) => Number(b["Days Since Upload"]) - Number(a["Days Since Upload"])
    || String(a["Evidence ID"]).localeCompare(String(b["Evidence ID"])));
  const metadata: DataRow = { "Run ID": runId, "Snapshot Date": snapshotDate, "Fiscal Year": fy };
  const snapshot: DataRow = { ...metadata, ...metrics(details), ...counts,
    "Source Data Date": sourceDataDate,
    "Source Report": state ? "EvidenceCreated+EvidenceUpdated" : sourceFormat === "axon-page-bundle" ? "EvidenceCreated" : "CSV export",
    "Creation From Date": creationFromDate, "Creation To Date": creationToDate,
    ...(state ? state.metadata : {}), "Sample Data": sampleData };
  const expected = details.length + Number(counts["Duplicate Rows Removed"]) + Number(counts["Excluded Status Rows"])
    + Number(counts["Categorized Rows"]) + Number(counts["Rejected Rows"]);
  if (expected !== Number(counts["Input Rows"])) throw new Error("Source row reconciliation failed.");
  if (details.length > 1048575) throw new Error("Excel row limit exceeded; use the CSV/Power Query route.");

  // All source validation finishes before workbook mutation.
  if (state) writeTable(workbook, "Evidence State", "EvidenceState", ["Evidence ID", "Record JSON"],
    state.rows.map(row => ({ "Evidence ID": row["Evidence ID"], "Record JSON": JSON.stringify(row) })));
  const detailFields = ["Run ID", "Snapshot Date", "Fiscal Year", "Evidence ID", "Days Since Upload",
    "Age Band", "Age Band Order", "Age Band Color", "Evidence Serial Number", "Evidence Type", "Status",
    "Owner Badge ID", "Owner First Name", "Owner Last Name", "Owner Role", "Owner Groups", "Serial Number",
    "Created Date (Record Start)", "Date Uploaded", "Days Between Create and Upload Date",
    "Component", "Component Name", "AOR", "Data Quality Notes", "External Evidence ID"];
  const metricFields = Object.keys(metrics([]));
  const summaries: { name: string; table: string; dimensions: string[] }[] = [
    { name: "AOR Summary", table: "AORSummary", dimensions: ["Component", "AOR"] },
    { name: "Component Summary", table: "ComponentSummary", dimensions: ["Component", "Component Name"] },
    { name: "Owner Summary", table: "OwnerSummary", dimensions: ["Owner Badge ID", "Owner First Name", "Owner Last Name",
      "Owner Role", "Component", "Component Name", "AOR"] }
  ];
  writeTable(workbook, "Uncategorized", "Uncategorized", detailFields, details);
  summaries.forEach(spec => {
    const summary = summarize(details, spec.dimensions, metadata);
    writeTable(workbook, spec.name, spec.table, Object.keys(metadata).concat(spec.dimensions, metricFields), summary);
  });
  writeTable(workbook, "Snapshot", "Snapshot", Object.keys(snapshot), [snapshot]);
  writeTable(workbook, "Data Quality", "DataQuality", ["Source Row", "Evidence ID", "Date Uploaded", "Reason"], rejected);
  const instructions = workbook.getWorksheet("Instructions") || workbook.addWorksheet("Instructions");
  instructions.getUsedRange()?.clear(ExcelScript.ClearApplyTo.all);
  const text = [sampleData ? "SYNTHETIC DEMO DATA" : "Uncategorized evidence report",
    `Snapshot: ${snapshotDate}; run: ${runId}`,
    "Normal: 0–14 days; Moderate: 15–29 days; Critical: 30+ days since upload.",
    "Calendar upload age does not measure the separate three-business-day policy.",
    "See Data Quality for excluded records. Missing owner groups remain Unassigned.",
    "All evidence types are retained, matching the documented source filters.",
    details.length === 0 ? "No uncategorized records." : "Details are sorted oldest first."];
  instructions.getRangeByIndexes(0, 0, text.length, 1).setValues(text.map(value => [value]));
  return { run_id: runId, snapshot_date: snapshotDate, total_uncategorized: details.length,
    normal: Number(snapshot["Normal Items"]), moderate: Number(snapshot["Moderate Items"]),
    critical: Number(snapshot["Critical Items"]), rejected_rows: rejected.length, sample_data: sampleData };
}

function clean(value: string): string {
  const text = value.trim();
  return ["", "na", "n/a", "null", "none", "nan", "<na>"].includes(text.toLowerCase()) ? "" : text;
}

function parseDay(value: string): number | null {
  const prefix = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prefix)) return null;
  const time = Date.parse(prefix + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === prefix ? time : null;
}

function organization(groups: string): DataRow {
  const name = groups.split(",", 1)[0].replace(/\bUsers\b|\b2nd Line Sup\b/gi, "").replace(/\s+/g, " ").trim();
  const upper = name.toUpperCase();
  const known = ["HSI", "ERO", "FLETC", "FOIA"].find(prefix => upper === prefix || upper.startsWith(prefix + " "));
  const component = name === "" ? "Unassigned" : upper.startsWith("OFFICE OF FIREARMS") ? "OFTP"
    : upper.startsWith("OFFICE OF PROFESSIONAL") ? "OPR" : known || "Other";
  return { "Component": component, "Component Name": name || "Unassigned",
    "AOR": name.replace(/^(HSI|ERO)\b/i, "AOR") || "Unassigned" };
}

function metrics(rows: DataRow[]): DataRow {
  const ages = rows.map(row => Number(row["Days Since Upload"]));
  return { "Total Uncategorized Items": rows.length,
    "Normal Items": rows.filter(row => row["Age Band"] === "Normal").length,
    "Moderate Items": rows.filter(row => row["Age Band"] === "Moderate").length,
    "Critical Items": rows.filter(row => row["Age Band"] === "Critical").length,
    "Average Days Since Upload": ages.length === 0 ? 0 : ages.reduce((a, b) => a + b, 0) / ages.length,
    "Oldest Days Since Upload": ages.reduce((oldest, value) => Math.max(oldest, value), 0) };
}

function summarize(rows: DataRow[], dimensions: string[], metadata: DataRow): DataRow[] {
  const groups = new Map<string, DataRow[]>();
  rows.forEach(row => {
    const key = JSON.stringify(dimensions.map(name => row[name]));
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  });
  const result: DataRow[] = [];
  groups.forEach(group => {
    const item: DataRow = { ...metadata, ...metrics(group) };
    dimensions.forEach(name => { item[name] = group[0][name]; });
    result.push(item);
  });
  return result.sort((a, b) => Number(b["Total Uncategorized Items"]) - Number(a["Total Uncategorized Items"]));
}

function writeTable(workbook: ExcelScript.Workbook, name: string, tableName: string,
  fields: string[], rows: DataRow[]): void {
  const sheet = workbook.getWorksheet(name) || workbook.addWorksheet(name);
  sheet.getTables().forEach(table => table.delete());
  sheet.getUsedRange()?.clear(ExcelScript.ClearApplyTo.all);
  const values: CellValue[][] = [fields];
  rows.forEach(row => values.push(fields.map(field => {
    const value = row[field];
    // The apostrophe is Excel's literal-text prefix, preventing formula execution.
    return typeof value === "string" && /^[=+\-@']/.test(value) ? "'" + value : value;
  })));
  const range = sheet.getRangeByIndexes(0, 0, values.length, fields.length);
  range.setNumberFormat("@");
  range.setValues(values);
  const table = sheet.addTable(range, true);
  table.setName(tableName);
  table.setPredefinedTableStyle("TableStyleMedium2");
  sheet.getFreezePanes().freezeRows(1);
  if (fields.includes("Days Since Upload") && rows.length > 0) {
    const ageRange = sheet.getRangeByIndexes(1, fields.indexOf("Days Since Upload"), rows.length, 1);
    ageRange.setNumberFormat("0");
    const critical = ageRange.addConditionalFormat(ExcelScript.ConditionalFormatType.cellValue).getCellValue();
    critical.setRule({ formula1: "29", operator: ExcelScript.ConditionalCellValueOperator.greaterThan });
    critical.getFormat().getFill().setColor("#C41230");
    critical.getFormat().getFont().setColor("#FFFFFF");
    const moderate = ageRange.addConditionalFormat(ExcelScript.ConditionalFormatType.cellValue).getCellValue();
    moderate.setRule({ formula1: "15", formula2: "29", operator: ExcelScript.ConditionalCellValueOperator.between });
    moderate.getFormat().getFill().setColor("#FFA500");
    const normal = ageRange.addConditionalFormat(ExcelScript.ConditionalFormatType.cellValue).getCellValue();
    normal.setRule({ formula1: "0", formula2: "14", operator: ExcelScript.ConditionalCellValueOperator.between });
    normal.getFormat().getFill().setColor("#FFFF00");
  }
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closedQuote = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
      continue;
    }
    if (char === '"') {
      if (field !== "" || closedQuote) throw new Error("Malformed CSV quoting.");
      quoted = true;
    } else if (char === ",") {
      row.push(field); field = ""; closedQuote = false;
    } else if (char === "\r" || char === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; closedQuote = false;
      if (char === "\r" && content[index + 1] === "\n") index++;
    } else {
      if (closedQuote) throw new Error("Malformed CSV quoting.");
      field += char;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field.");
  if (field !== "" || row.length > 0 || closedQuote) { row.push(field); rows.push(row); }
  return rows;
}

function parseUtc(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const time = Date.parse(value + "Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value ? time : null;
}

function axonBundleRows(bundle: AxonBundle): SourceRow[] {
  if (!bundle || bundle.schema_version !== 1 || !["EvidenceCreated", "EvidenceUpdated"].includes(bundle.report_type)) {
    throw new Error("Expected an EvidenceCreated or EvidenceUpdated page bundle with schema_version 1.");
  }
  if (bundle.sample_data !== undefined && typeof bundle.sample_data !== "boolean") {
    throw new Error("sample_data must be a boolean when provided.");
  }
  if (bundle.report_type === "EvidenceCreated") {
    const start = typeof bundle.from_date === "string" ? parseDay(bundle.from_date) : null;
    const end = typeof bundle.to_date === "string" ? parseDay(bundle.to_date) : null;
    if (start === null || end === null || bundle.from_date?.length !== 10 || bundle.to_date?.length !== 10 || end < start) {
      throw new Error("Page bundle requires a valid creation-date range.");
    }
  } else {
    const start = parseUtc(bundle.updated_from_datetime), end = parseUtc(bundle.updated_to_datetime);
    if (start === null || end === null || end < start) throw new Error("Updated report requires a valid UTC timestamp range.");
  }
  if (!Number.isInteger(bundle.page_size) || bundle.page_size < 1 || bundle.page_size > 50
      || !Array.isArray(bundle.pages) || bundle.pages.length === 0) {
    throw new Error("Page bundle requires page_size 1–50 and a terminal page.");
  }
  const output: SourceRow[] = [];
  bundle.pages.forEach((page, index) => {
    if (!page || page.page_offset !== index || !Number.isInteger(page.page_offset) || !Array.isArray(page.data)) {
      throw new Error("Report pages must be contiguous from page_offset 0 and contain data arrays.");
    }
    if (page.data.length > bundle.page_size) throw new Error("Report page exceeds the configured page size.");
    if (page.data.length === 0 && index !== bundle.pages.length - 1) throw new Error("Empty terminal page must be last.");
    if (page.data.length > 0 && index === bundle.pages.length - 1) throw new Error("Incomplete report: empty terminal page is missing.");
    page.data.forEach(record => {
      if (!record || typeof record !== "object" || Array.isArray(record)
          || !["evidenceId", "status", "dateUploaded", "ownerGroups", "categories"].every(key => Object.prototype.hasOwnProperty.call(record, key))) {
        throw new Error("Report record is missing required API fields.");
      }
      const text = (value: string | null | undefined): string => {
        if (value === null || value === undefined) return "";
        if (typeof value !== "string") throw new Error("API metadata and identifier fields must be text or null.");
        return value.trim();
      };
      const names = (value: string[] | null): string[] => {
        if (value === null) return [];
        if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
          throw new Error("API groups/categories must be arrays of nonempty names or null.");
        }
        return value.map(item => item.trim());
      };
      const groups = names(record.ownerGroups);
      let categories: string[];
      if (bundle.report_type === "EvidenceUpdated" && record.categories !== null) {
        if (!Array.isArray(record.categories) || record.categories.some(item => typeof item !== "object" || item === null
          || typeof item.category !== "string" || item.category.trim() === "")) {
          throw new Error("EvidenceUpdated categories must contain category objects.");
        }
        categories = record.categories.map(item => typeof item === "string" ? "" : item.category.trim());
      } else categories = names(record.categories as string[] | null);
      const values = [text(record.evidenceId), categories.length ? JSON.stringify(categories) : "", text(record.status),
        text(record.dateUploaded), groups.join(", "), "", text(record.evidenceType), text(record.ownerBadgeId),
        text(record.ownerFirstName), text(record.ownerLastName), text(record.ownerRole), text(record.serialNumber),
        text(record.dateRecordStart), text(record.idExternal)];
      const row: SourceRow = {};
      axonFields.forEach((field, index) => { row[field] = values[index]; });
      output.push(row);
    });
  });
  return output;
}

function sourceRowsCsv(rows: SourceRow[]): string {
  const escape = (value: string): string => /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  return [axonFields].concat(rows.map(row => axonFields.map(field => row[field])))
    .map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
}

function axonBundleCsv(bundle: AxonBundle): string {
  // The single-report route is a complete snapshot, never an incremental delta.
  if (bundle?.report_type !== "EvidenceCreated") throw new Error("Snapshot input must use EvidenceCreated.");
  return sourceRowsCsv(axonBundleRows(bundle));
}

function readStateSheet(workbook: ExcelScript.Workbook, name: string): CellValue[][] {
  const sheet = workbook.getWorksheet(name);
  const range = sheet?.getUsedRange();
  if (!range) throw new Error("Previous published workbook has no " + name + " state.");
  return range.getValues();
}

function reconcileAxon(workbook: ExcelScript.Workbook, refresh: AxonRefresh): ReconciledState {
  if (!refresh || refresh.schema_version !== 1 || !["backfill", "incremental"].includes(refresh.mode)
      || typeof refresh.previous_run_id !== "string" || !refresh.created || !refresh.updated
      || refresh.created.report_type !== "EvidenceCreated" || refresh.updated.report_type !== "EvidenceUpdated") {
    throw new Error("Invalid refresh envelope: complete Created and Updated reports are required.");
  }
  if (refresh.sample_data !== undefined && typeof refresh.sample_data !== "boolean") throw new Error("sample_data must be boolean.");
  const scopeFrom = parseDay(refresh.creation_from_date || ""), scopeTo = parseDay(refresh.creation_to_date || "");
  if (scopeFrom === null || scopeTo === null || refresh.creation_from_date.length !== 10
      || refresh.creation_to_date.length !== 10 || scopeTo < scopeFrom || refresh.created.to_date !== refresh.creation_to_date) {
    throw new Error("Invalid refresh creation scope.");
  }
  const created = axonBundleRows(refresh.created), updated = axonBundleRows(refresh.updated);
  const state = new Map<string, SourceRow>();
  let containsSample = refresh.sample_data === true || refresh.created.sample_data === true || refresh.updated.sample_data === true;
  if (refresh.mode === "incremental") {
    const snapshot = readStateSheet(workbook, "Snapshot");
    if (snapshot.length !== 2) throw new Error("Previous workbook must have one Snapshot row.");
    const prior: DataRow = {};
    snapshot[0].forEach((field, index) => { prior[String(field)] = snapshot[1][index]; });
    containsSample = containsSample || prior["Sample Data"] === true;
    const previousTo = parseDay(String(prior["Creation To Date"] || ""));
    const previousWatermark = parseUtc(String(prior["Updated Through UTC"] || ""));
    const from = parseUtc(refresh.updated.updated_from_datetime), to = parseUtc(refresh.updated.updated_to_datetime);
    const createdFrom = parseDay(refresh.created.from_date || "");
    if (refresh.previous_run_id === "" || prior["Run ID"] !== refresh.previous_run_id
        || prior["Source Report"] !== "EvidenceCreated+EvidenceUpdated"
        || prior["Creation From Date"] !== refresh.creation_from_date || previousTo === null || previousWatermark === null
        || createdFrom === null || createdFrom > previousTo || createdFrom < scopeFrom || scopeTo < previousTo
        || from === null || to === null || from > previousWatermark || to <= previousWatermark) {
      throw new Error("Incremental refresh has a stale base, changed scope, or watermark gap; publish stopped.");
    }
    const ledger = readStateSheet(workbook, "Evidence State");
    if (ledger[0].length !== 2 || ledger[0][0] !== "Evidence ID" || ledger[0][1] !== "Record JSON") throw new Error("Invalid state headers.");
    ledger.slice(1).forEach(cells => {
      if (cells.every(value => value === "")) return;
      const row = JSON.parse(String(cells[1])) as SourceRow;
      if (!row || !axonFields.every(field => typeof row[field] === "string") || row["Evidence ID"] === ""
          || state.has(row["Evidence ID"])) throw new Error("Previous evidence state is corrupt.");
      state.set(row["Evidence ID"], row);
    });
    if (state.size !== Number(prior["State Rows"])) throw new Error("Previous evidence state row count does not reconcile.");
  } else if (refresh.previous_run_id !== "" || refresh.created.from_date !== refresh.creation_from_date) {
    throw new Error("Backfill must start at the configured creation date and have no previous run ID.");
  }
  let outsideScope = 0;
  const apply = (rows: SourceRow[]): void => {
    const seen = new Map<string, string>();
    rows.forEach(row => {
      const id = row["Evidence ID"], day = parseDay(row["Created Date (Record Start)"]);
      if (id === "" || day === null) throw new Error("Refresh requires internal evidence IDs and valid recording-start dates.");
      const signature = JSON.stringify(row);
      if (seen.has(id)) {
        if (seen.get(id) !== signature) throw new Error("Conflicting duplicate evidence IDs in a report; publish stopped.");
        return;
      }
      seen.set(id, signature);
      if (day < scopeFrom || day > scopeTo) { state.delete(id); outsideScope++; }
      else state.set(id, row);
    });
  };
  apply(created);
  apply(updated); // Current Updated metadata wins over Created; retain all statuses/categories in the ledger.
  const rows: SourceRow[] = [];
  state.forEach(row => {
    const day = parseDay(row["Created Date (Record Start)"]);
    if (day === null || day < scopeFrom || day > scopeTo || JSON.stringify(row).length > 32767
        || row["Evidence ID"].length > 32767) throw new Error("Evidence state is out of scope or exceeds Excel cell limits.");
    rows.push(row);
  });
  if (rows.length > 1048575) throw new Error("Evidence state exceeds the Excel row limit.");
  rows.sort((a, b) => a["Evidence ID"].localeCompare(b["Evidence ID"]));
  return { rows, metadata: { "Refresh Mode": refresh.mode, "Previous Run ID": refresh.previous_run_id,
    "Updated From UTC": refresh.updated.updated_from_datetime || "", "Updated Through UTC": refresh.updated.updated_to_datetime || "",
    "State Rows": rows.length, "Created Rows Received": created.length, "Updated Rows Received": updated.length,
    "Out of Scope Updates": outsideScope, "Sample Data": containsSample } };
}

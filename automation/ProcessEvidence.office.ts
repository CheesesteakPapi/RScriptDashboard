/** Run in Excel Online through Power Automate's Run script action.
 * Run against a NEW COPY of report-template.xlsx; publish only after success.
 * No network calls, R runtime, desktop process, or embedded credentials.
 */
type CellValue = string | number | boolean;
interface DataRow { [key: string]: CellValue; }
interface SourceRow { [key: string]: string; }
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
  sampleData: boolean = false): ScriptResult {
  const required = ["Evidence ID", "Categories", "Status", "Date Uploaded", "Owner Groups"];
  const optional = ["Evidence Serial Number", "Evidence Type", "Owner Badge ID", "Owner First Name",
    "Owner Last Name", "Owner Role", "Serial Number", "Created Date (Record Start)"];
  const known = required.concat(optional);
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
    if (cells.every(value => clean(value) === "")) {
      counts["Blank Rows Removed"] = Number(counts["Blank Rows Removed"]) + 1;
      continue;
    }
    if (cells.length !== headers.length) throw new Error(`CSV record ${index + 1} has the wrong number of cells.`);
    counts["Input Rows"] = Number(counts["Input Rows"]) + 1;
    const source: SourceRow = {};
    known.forEach(name => {
      const position = headers.indexOf(name);
      source[name] = position < 0 ? "" : clean(cells[position]);
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
    "Sample Data": sampleData, "Source Data Date": sourceDataDate };
  const expected = details.length + Number(counts["Duplicate Rows Removed"]) + Number(counts["Excluded Status Rows"])
    + Number(counts["Categorized Rows"]) + Number(counts["Rejected Rows"]);
  if (expected !== Number(counts["Input Rows"])) throw new Error("Source row reconciliation failed.");
  if (details.length > 1048575) throw new Error("Excel row limit exceeded; use the CSV/Power Query route.");

  // All source validation finishes before workbook mutation.
  const detailFields = ["Run ID", "Snapshot Date", "Fiscal Year", "Evidence ID", "Days Since Upload",
    "Age Band", "Age Band Order", "Age Band Color", "Evidence Serial Number", "Evidence Type", "Status",
    "Owner Badge ID", "Owner First Name", "Owner Last Name", "Owner Role", "Owner Groups", "Serial Number",
    "Created Date (Record Start)", "Date Uploaded", "Days Between Create and Upload Date",
    "Component", "Component Name", "AOR", "Data Quality Notes"];
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

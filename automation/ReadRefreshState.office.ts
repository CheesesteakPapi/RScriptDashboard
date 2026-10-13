/** Read only operational metadata from the working COPY of the previous workbook.
 * The incremental flow uses this output to build acquisition windows.
 */
interface RefreshState {
  previous_run_id: string;
  creation_from_date: string;
  creation_to_date: string;
  updated_through_utc: string;
  sample_data: boolean;
}
function main(workbook: ExcelScript.Workbook): RefreshState {
  const table = workbook.getTable("Snapshot");
  if (!table || table.getRowCount() !== 1) throw new Error("Expected one published Snapshot row; perform a backfill.");
  const headers = table.getHeaderRowRange().getValues()[0];
  const values = table.getRangeBetweenHeaderAndTotal().getValues()[0];
  const field = (name: string): string => {
    const index = headers.indexOf(name);
    if (index < 0 || typeof values[index] !== "string" || values[index] === "") throw new Error("Missing refresh state: " + name);
    return String(values[index]);
  };
  if (field("Source Report") !== "EvidenceCreated+EvidenceUpdated") throw new Error("This workbook needs an API backfill before incremental refresh.");
  const sampleIndex = headers.indexOf("Sample Data");
  return { previous_run_id: field("Run ID"), creation_from_date: field("Creation From Date"),
    creation_to_date: field("Creation To Date"), updated_through_utc: field("Updated Through UTC"),
    sample_data: sampleIndex >= 0 && values[sampleIndex] === true };
}

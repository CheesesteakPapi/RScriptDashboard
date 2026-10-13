// Loaded entity/table: Snapshot. Keep this one-row table even when details are empty.
let
    Source = ReportSource[Snapshot],
    Typed = Table.TransformColumnTypes(Source, {
        {"Run ID", type text}, {"Snapshot Date", type date}, {"Source Data Date", type date},
        {"Fiscal Year", Int64.Type}, {"Total Uncategorized Items", Int64.Type},
        {"Normal Items", Int64.Type}, {"Moderate Items", Int64.Type}, {"Critical Items", Int64.Type},
        {"Average Days Since Upload", type number}, {"Oldest Days Since Upload", Int64.Type},
        {"Input Rows", Int64.Type}, {"Blank Rows Removed", Int64.Type},
        {"Duplicate Rows Removed", Int64.Type}, {"Excluded Status Rows", Int64.Type},
        {"Categorized Rows", Int64.Type}, {"Rejected Rows", Int64.Type}, {"Sample Data", type logical}
    })
in Typed

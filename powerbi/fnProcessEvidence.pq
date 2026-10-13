// Power Query M. Create a function query with this exact name; disable load.
// Run this in Power Query Online (a Power BI Service dataflow).
(content as binary, snapshotDate as date, runId as text,
 optional sampleData as nullable logical,
 optional sourceDataDate as nullable date) as record =>
let
    ModerateDay = 15,
    CriticalDay = 30,
    Required = {"Evidence ID", "Categories", "Status", "Date Uploaded", "Owner Groups"},
    Optional = {"Evidence Serial Number", "Evidence Type", "Owner Badge ID", "Owner First Name",
        "Owner Last Name", "Owner Role", "Serial Number", "Created Date (Record Start)", "External Evidence ID"},
    Known = Required & Optional,
    Clean = (value as any) as nullable text =>
        let text = if value = null then "" else Text.Trim(Text.From(value))
        in if List.Contains({"", "na", "n/a", "null", "none", "nan", "<na>"}, Text.Lower(text)) then null else text,
    TextOrBlank = (value as any) as text => if value = null then "" else Text.From(value),
    ParseDay = (value as any) as nullable date =>
        if value = null then null else
            try Date.FromText(Text.Start(Text.From(value), 10), [Format="yyyy-MM-dd", Culture="en-US"]) otherwise null,
    Raw = Csv.Document(content, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
    HeaderNames = if Table.IsEmpty(Raw) then error "Source CSV has no header" else
        List.Transform(Record.FieldValues(Table.First(Raw)), each Text.Trim(TextOrBlank(_))),
    CheckedNames = if List.Contains(HeaderNames, "") or List.Count(List.Distinct(HeaderNames))<>List.Count(HeaderNames)
        then error "Source CSV has blank or duplicate column names" else HeaderNames,
    Headers = Table.RenameColumns(Table.Skip(Raw, 1), List.Zip({Table.ColumnNames(Raw), CheckedNames})),
    Missing = List.Difference(Required, Table.ColumnNames(Headers)),
    Checked = if List.Count(Missing) > 0 then
        error Error.Record("Source schema", "Missing required Evidence.com columns", Missing) else Headers,
    Normalized = Table.TransformColumns(Checked,
        List.Transform(Table.ColumnNames(Checked), each {_, Clean, type nullable text})),
    Indexed = Table.AddIndexColumn(Normalized, "Source Row", 2, 1, Int64.Type),
    WithOptional = List.Accumulate(Optional, Indexed, (table, name) =>
        if Table.HasColumns(table, name) then table else Table.AddColumn(table, name, each null, type nullable text)),
    WithBlank = Table.AddColumn(WithOptional, "Blank Row", each
        List.NonNullCount(Record.FieldValues(Record.RemoveFields(_, {"Source Row"}))) = 0, type logical),
    NonBlank = Table.Buffer(Table.SelectRows(WithBlank, each not [Blank Row])),
    WithIds = Table.SelectRows(NonBlank, each [Evidence ID] <> null),
    WithoutIds = Table.SelectRows(NonBlank, each [Evidence ID] = null),
    IdGroups = Table.Group(WithIds, {"Evidence ID"}, {{"Rows", each _, type table}}),
    Conflicts = Table.SelectRows(IdGroups, each
        Table.RowCount(Table.Distinct(Table.SelectColumns([Rows], Known))) > 1),
    UniqueIds = if Table.RowCount(Conflicts) > 0 then
        error Error.Record("Source integrity", "Conflicting duplicate evidence IDs; do not publish this run", null)
        else if Table.IsEmpty(IdGroups) then Table.FirstN(WithIds, 0)
        else Table.FromRecords(List.Transform(IdGroups[Rows], each Table.First(_)), Table.ColumnNames(WithIds)),
    Unique = Table.Buffer(Table.Combine({UniqueIds, WithoutIds})),
    IsEligibleStatus = (row as record) as logical =>
        List.Contains({"active", "queued for deletion"}, Text.Lower(TextOrBlank(row[Status]))),
    StatusRows = Table.SelectRows(Unique, each IsEligibleStatus(_)),
    Eligible = Table.SelectRows(StatusRows, each [Categories] = null),
    WithUpload = Table.AddColumn(Eligible, "Parsed Upload", each ParseDay([Date Uploaded]), type nullable date),
    WithReason = Table.AddColumn(WithUpload, "Reason", each
        if [Evidence ID] = null then "Missing evidence ID"
        else if [Parsed Upload] = null then "Missing or invalid upload date"
        else if [Parsed Upload] > snapshotDate then "Upload date is after snapshot date"
        else null, type nullable text),
    Invalid = Table.SelectRows(WithReason, each [Reason] <> null),
    Rejected = Table.SelectColumns(Invalid, {"Source Row", "Evidence ID", "Date Uploaded", "Reason"}),
    Valid = Table.SelectRows(WithReason, each [Reason] = null),
    FiscalYear = Date.Year(snapshotDate) + (if Date.Month(snapshotDate) >= 10 then 1 else 0),
    Org = (groups as nullable text) as record =>
        let
            text = Text.BeforeDelimiter(TextOrBlank(groups) & ",", ","),
            tokens = List.Select(Text.SplitAny(Text.Trim(text), " #(tab)#(cr)#(lf)"), each _ <> ""),
            lowerTokens = List.Transform(tokens, Text.Lower),
            phraseStarts = List.Select(List.Positions(tokens), (i) =>
                if i+2>=List.Count(tokens) then false else
                    lowerTokens{i}="2nd" and lowerTokens{i+1}="line" and lowerTokens{i+2}="sup"),
            skipPositions = List.Combine(List.Transform(phraseStarts, each {_, _+1, _+2})),
            keepPositions = List.Select(List.Positions(tokens), each
                not List.Contains(skipPositions, _) and lowerTokens{_}<>"users"),
            name = Text.Combine(List.Transform(keepPositions, each tokens{_}), " "),
            upper = Text.Upper(name),
            Prefix = (value as text) as logical => upper = value or Text.StartsWith(upper, value & " "),
            component = if name = "" then "Unassigned"
                else if Prefix("HSI") then "HSI" else if Prefix("ERO") then "ERO"
                else if Prefix("FLETC") then "FLETC" else if Prefix("FOIA") then "FOIA"
                else if Text.StartsWith(upper, "OFFICE OF FIREARMS") then "OFTP"
                else if Text.StartsWith(upper, "OFFICE OF PROFESSIONAL") then "OPR" else "Other",
            orgName = if name = "" then "Unassigned" else name,
            aor = if component = "HSI" or component = "ERO" then "AOR" & Text.Range(name, 3) else orgName
        in [Component=component, #"Component Name"=orgName, AOR=aor],
    DetailRecords = List.Transform(Table.ToRecords(Valid), (row) =>
        let
            age = Duration.Days(snapshotDate - row[Parsed Upload]),
            band = if age >= CriticalDay then "Critical" else if age >= ModerateDay then "Moderate" else "Normal",
            org = Org(row[Owner Groups]),
            created = ParseDay(row[#"Created Date (Record Start)"]),
            delay = if created = null then null else if created <= row[Parsed Upload]
                then Duration.Days(row[Parsed Upload] - created) else null,
            notes = List.RemoveNulls({
                if row[#"Created Date (Record Start)"] <> null and created = null then "Invalid created date" else null,
                if created <> null and created > row[Parsed Upload] then "Created date is after upload date" else null,
                if row[Owner Badge ID] = null then "Missing owner badge ID" else null,
                if org[Component] = "Other" then "Unrecognized component" else null
            })
        in Record.Combine({Record.SelectFields(row, Optional), org, [
            #"Run ID"=runId, #"Snapshot Date"=snapshotDate, #"Fiscal Year"=FiscalYear,
            #"Evidence ID"=row[Evidence ID], #"Days Since Upload"=age,
            #"Age Band"=band, #"Age Band Order"=if band="Critical" then 3 else if band="Moderate" then 2 else 1,
            #"Age Band Color"=if band="Critical" then "#C41230" else if band="Moderate" then "#FFA500" else "#FFFF00",
            Status=row[Status], #"Owner Groups"=row[Owner Groups],
            #"Date Uploaded"=row[Parsed Upload], #"Created Date (Record Start)"=created,
            #"Days Between Create and Upload Date"=delay, #"Data Quality Notes"=Text.Combine(notes, "; ")
        ]})),
    DetailColumns = {"Run ID", "Snapshot Date", "Fiscal Year", "Evidence ID", "Days Since Upload",
        "Age Band", "Age Band Order", "Age Band Color", "Evidence Serial Number", "Evidence Type", "Status",
        "Owner Badge ID", "Owner First Name", "Owner Last Name", "Owner Role", "Owner Groups", "Serial Number",
        "Created Date (Record Start)", "Date Uploaded", "Days Between Create and Upload Date",
        "Component", "Component Name", "AOR", "Data Quality Notes", "External Evidence ID"},
    Dates = {"Snapshot Date", "Created Date (Record Start)", "Date Uploaded"},
    Integers = {"Fiscal Year", "Days Since Upload", "Age Band Order", "Days Between Create and Upload Date"},
    DetailTypes = List.Transform(DetailColumns, each {_,
        if List.Contains(Dates, _) then type date else if List.Contains(Integers, _) then Int64.Type else type text}),
    TypedDetails = Table.TransformColumnTypes(Table.FromRecords(DetailRecords, DetailColumns, MissingField.UseNull), DetailTypes),
    Details = Table.Sort(TypedDetails, {{"Days Since Upload", Order.Descending}, {"Evidence ID", Order.Ascending}}),
    CountBand = (band as text) as number => Table.RowCount(Table.SelectRows(Details, each [Age Band]=band)),
    Ages = Details[Days Since Upload],
    SnapshotRecord = [#"Run ID"=runId, #"Snapshot Date"=snapshotDate, #"Fiscal Year"=FiscalYear,
        #"Total Uncategorized Items"=Table.RowCount(Details), #"Normal Items"=CountBand("Normal"),
        #"Moderate Items"=CountBand("Moderate"), #"Critical Items"=CountBand("Critical"),
        #"Average Days Since Upload"=if List.IsEmpty(Ages) then 0 else List.Average(Ages),
        #"Oldest Days Since Upload"=if List.IsEmpty(Ages) then 0 else List.Max(Ages),
        #"Input Rows"=Table.RowCount(NonBlank),
        #"Blank Rows Removed"=Table.RowCount(WithBlank)-Table.RowCount(NonBlank),
        #"Duplicate Rows Removed"=Table.RowCount(NonBlank)-Table.RowCount(Unique),
        #"Excluded Status Rows"=Table.RowCount(Unique)-Table.RowCount(StatusRows),
        #"Categorized Rows"=Table.RowCount(StatusRows)-Table.RowCount(Eligible),
        #"Rejected Rows"=Table.RowCount(Rejected),
        #"Sample Data"=if sampleData=null then false else sampleData, #"Source Data Date"=sourceDataDate,
        #"Source Report"="CSV export", #"Creation From Date"=null, #"Creation To Date"=null],
    Snapshot = Table.FromRecords({SnapshotRecord}),
    Result = [Details=Details, Snapshot=Snapshot, Rejected=Rejected]
in
    Result

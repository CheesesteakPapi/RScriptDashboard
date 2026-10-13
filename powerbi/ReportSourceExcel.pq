// Preferred Excel-cloud route. Create this staging query as ReportSource; disable load.
// Use this INSTEAD OF the raw CSV ReportSource.pq, with the same downstream queries.
let
    SiteUrl = "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE",
    ReportFolderUrl = SiteUrl & "/Shared Documents/BWC Reporting/",
    Files = SharePoint.Files(SiteUrl, [ApiVersion=15]),
    Matches = Table.SelectRows(Files, each [Folder Path]=ReportFolderUrl & "latest/"
        and [Name]="Uncategorized Report.xlsx"),
    Binary = if Table.RowCount(Matches)<>1 then error "Expected one completed report workbook"
        else Binary.Buffer(Matches{0}[Content]),
    Book = Excel.Workbook(Binary, null, true),
    ReadTable = (name as text) as table =>
        let matches = Table.SelectRows(Book, each [Kind]="Table" and [Item]=name)
        in if Table.RowCount(matches)<>1 then error "Missing report table" else matches{0}[Data],
    RawDetails = ReadTable("Uncategorized"),
    // Excel may materialize a blank row in an otherwise empty named table.
    ValidDetails = Table.SelectRows(RawDetails, each [Evidence ID]<>null and Text.Trim(Text.From([Evidence ID]))<>""),
    Dates = {"Snapshot Date", "Created Date (Record Start)", "Date Uploaded"},
    Integers = {"Fiscal Year", "Days Since Upload", "Age Band Order", "Days Between Create and Upload Date"},
    Types = List.Transform(Table.ColumnNames(ValidDetails), each {_,
        if List.Contains(Dates, _) then type date else if List.Contains(Integers, _) then Int64.Type else type text}),
    NullBlanks = Table.ReplaceValue(ValidDetails, "", null, Replacer.ReplaceValue, Dates & Integers),
    Details = Table.TransformColumnTypes(NullBlanks, Types),
    SnapshotRaw = ReadTable("Snapshot"),
    SnapshotDateColumns = List.Intersect({Table.ColumnNames(SnapshotRaw),
        {"Source Data Date", "Creation From Date", "Creation To Date"}}),
    Snapshot = Table.ReplaceValue(SnapshotRaw, "", null, Replacer.ReplaceValue, SnapshotDateColumns),
    RejectedRaw = ReadTable("DataQuality"),
    Rejected = Table.SelectRows(RejectedRaw, each [Reason]<>null and Text.Trim(Text.From([Reason]))<>"")
in
    [Details=Details, Snapshot=Snapshot, Rejected=Rejected]

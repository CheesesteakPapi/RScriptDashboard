// Staging query: configure these two URLs, name this query ReportSource, disable load.
let
    SiteUrl = "https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE",
    ReportFolderUrl = SiteUrl & "/Shared Documents/BWC Reporting/",
    Files = SharePoint.Files(SiteUrl, [ApiVersion=15]),
    ReadOne = (folder as text, name as text) as binary =>
        let matches = Table.SelectRows(Files, each [Folder Path]=folder and [Name]=name)
        in if Table.RowCount(matches)<>1 then
            error Error.Record("Source publication", "Expected one completed report input file", name)
        else Binary.Buffer(matches{0}[Content]),
    Manifest = Json.Document(ReadOne(ReportFolderUrl & "latest/", "source_manifest.json")),
    RelativeFolder = Text.From(Manifest[raw_relative_folder]),
    SafeFolder = if Manifest[schema_version]<>1 or not Text.StartsWith(RelativeFolder, "raw/")
        or Text.Contains(RelativeFolder, "..") or not Text.EndsWith(RelativeFolder, "/") then
            error Error.Record("Source manifest", "Unsupported schema or invalid relative folder", null)
        else RelativeFolder,
    Content = ReadOne(ReportFolderUrl & SafeFolder, "evidence.csv"),
    SnapshotDate = Date.FromText(Text.From(Manifest[snapshot_date]), [Format="yyyy-MM-dd"]),
    SourceDate = if Manifest[source_data_date]=null then null
        else Date.FromText(Text.From(Manifest[source_data_date]), [Format="yyyy-MM-dd"]),
    Result = fnProcessEvidence(Content, SnapshotDate, Text.From(Manifest[run_id]),
        Logical.From(Manifest[sample_data]), SourceDate)
in
    Result

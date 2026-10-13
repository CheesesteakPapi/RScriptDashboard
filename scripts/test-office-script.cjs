// Execute the Office Script with a workbook test double; not an Excel Online deployment test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(process.argv[2] || 'typescript');
const source = fs.readFileSync(path.join(root, 'automation/ProcessEvidence.office.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true
});
const syntaxErrors = (compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
if (syntaxErrors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(syntaxErrors, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n'
}));

class Range {
  constructor(sheet, row, column, rows, columns) { Object.assign(this, { sheet, row, column, rows, columns }); }
  getValues() { return this.sheet.values; }
  setNumberFormat() {}
  setValues(values) { this.sheet.values = values; this.sheet.workbook.writes++; }
  clear() { this.sheet.values = null; this.sheet.workbook.writes++; }
  addConditionalFormat() {
    const rule = {};
    this.sheet.rules.push(rule);
    return { getCellValue: () => ({
      setRule: values => Object.assign(rule, values),
      getFormat: () => ({
        getFill: () => ({ setColor: value => { rule.fill = value; } }),
        getFont: () => ({ setColor: value => { rule.font = value; } })
      })
    }) };
  }
}
class Sheet {
  constructor(workbook, name) { Object.assign(this, { workbook, name, values: null, tables: [], rules: [] }); }
  getTables() { return this.tables; }
  getUsedRange() { return this.values ? new Range(this, 0, 0, this.values.length, this.values[0].length) : undefined; }
  getRangeByIndexes(...args) { return new Range(this, ...args); }
  addTable() {
    const table = { name: '', delete: () => { this.tables = this.tables.filter(item => item !== table); },
      getRowCount: () => this.values.length - 1,
      getHeaderRowRange: () => ({ getValues: () => [this.values[0]] }),
      getRangeBetweenHeaderAndTotal: () => ({ getValues: () => this.values.slice(1) }),
      setName: name => { table.name = name; }, setPredefinedTableStyle: () => {} };
    this.tables.push(table);
    return table;
  }
  getFreezePanes() { return { freezeRows: () => {} }; }
}
class Workbook {
  constructor() { this.sheets = new Map(); this.writes = 0; }
  getWorksheet(name) { return this.sheets.get(name); }
  getTable(name) { return [...this.sheets.values()].flatMap(sheet => sheet.tables).find(table => table.name === name); }
  addWorksheet(name) { const sheet = new Sheet(this, name); this.sheets.set(name, sheet); return sheet; }
}
const context = {
  ExcelScript: { ClearApplyTo: { all: 'all' }, ConditionalFormatType: { cellValue: 'cellValue' },
    ConditionalCellValueOperator: { greaterThan: 'greaterThan', between: 'between' } }
};
vm.createContext(context);
vm.runInContext(compiled.outputText, context);
const readSource = fs.readFileSync(path.join(root, 'automation/ReadRefreshState.office.ts'), 'utf8');
const readCompiled = ts.transpileModule(readSource, { compilerOptions: { target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true });
assert.equal((readCompiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const readContext = vm.createContext({});
vm.runInContext(readCompiled.outputText, readContext);
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = fs.readFileSync(path.join(root, 'examples/evidence.sample.csv'), 'utf8');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'examples/expected-summary.json'), 'utf8'));
const apiFixture = JSON.parse(fs.readFileSync(path.join(root, 'examples/axon-pages.sample.json'), 'utf8'));
const cases = [];
function test(name, callback) { callback(); cases.push(name); console.log(`PASS: ${name}`); }
function sheetRecords(book, name) {
  const [headers, ...rows] = book.getWorksheet(name).values;
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

test('Office Script fixture matches Python acceptance counts and creates seven sheets', () => {
  const book = new Workbook();
  const result = context.main(book, fixture, '2026-10-13', 'demo_20261013', '2026-10-13', true);
  assert.equal(book.sheets.size, 7);
  assert.equal(result.total_uncategorized, 8);
  assert.equal(result.normal, 2);
  assert.equal(result.moderate, 2);
  assert.equal(result.critical, 4);
  assert.equal(result.rejected_rows, 3);
  const snapshot = sheetRecords(book, 'Snapshot')[0];
  for (const [field, value] of Object.entries(expected)) assert.equal(snapshot[field], value, field);
  assert.equal(snapshot['Average Days Since Upload'], 29.125);
  assert.equal(snapshot['Sample Data'], true);
  const detail = sheetRecords(book, 'Uncategorized');
  assert.equal(detail.length, 8);
  assert.equal(detail[0]['Days Since Upload'], 75);
  assert.ok(detail.some(item => item.Component === 'Unassigned'));
  assert.ok(detail.some(item => item.Component === 'Other'));
  assert.ok(detail.every(item => String(item['Owner Badge ID']).startsWith('000')));
  for (const name of ['AOR Summary', 'Component Summary', 'Owner Summary']) {
    assert.equal(sheetRecords(book, name).reduce((total, item) => total + item['Total Uncategorized Items'], 0), 8);
  }
  const rules = book.getWorksheet('Uncategorized').rules;
  assert.equal(rules[0].formula1, '29');
  assert.equal(rules[0].fill, '#C41230');
});

test('14/15/29/30 upload-age boundaries agree with the chosen bands', () => {
  const details = sheetRecords((() => { const book = new Workbook(); context.main(book, fixture, '2026-10-13', 'boundaries'); return book; })(), 'Uncategorized');
  for (const [days, expectedBand] of [[14, 'Normal'], [15, 'Moderate'], [29, 'Moderate'], [30, 'Critical']]) {
    assert.equal(details.find(item => item['Days Since Upload'] === days)['Age Band'], expectedBand);
  }
});

test('empty dataset still writes a zero snapshot and detail headers', () => {
  const book = new Workbook();
  const header = fixture.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const result = context.main(book, header + '\r\n', '2026-10-13', 'empty');
  assert.equal(result.total_uncategorized, 0);
  assert.equal(sheetRecords(book, 'Snapshot')[0]['Critical Items'], 0);
  assert.equal(sheetRecords(book, 'Uncategorized').length, 0);
});

test('conflicting duplicates fail before workbook mutation', () => {
  const book = new Workbook();
  const input = 'Evidence ID,Categories,Status,Date Uploaded,Owner Groups\n1,,Active,2026-10-13,HSI\n1,case,Active,2026-10-13,HSI\n';
  assert.throws(() => context.main(book, input, '2026-10-13', 'conflict'), /Conflicting duplicate/);
  assert.equal(book.writes, 0);
});

test('bad source schema fails before workbook mutation', () => {
  const book = new Workbook();
  assert.throws(() => context.main(book, 'ID,Status\n1,Active\n', '2026-10-13', 'missing'), /Missing required/);
  assert.equal(book.writes, 0);
});

test('CSV parser preserves commas, quotes and newlines inside quoted fields', () => {
  assert.deepEqual(plain(context.parseCsv('a,b\r\n"one,two","line1\nline2 ""quoted"""\r\n')), [
    ['a', 'b'], ['one,two', 'line1\nline2 "quoted"']
  ]);
  assert.throws(() => context.parseCsv('a\n"unfinished'), /Unterminated/);
});

test('calendar date validation rejects normalized impossible dates and handles October rollover', () => {
  assert.equal(context.parseDay('2026-02-30'), null);
  assert.equal(context.parseDay('2026-13-01'), null);
  const book = new Workbook();
  context.main(book, fixture.replace(/^\uFEFF/, '').split(/\r?\n/)[0] + '\n', '2026-09-30', 'fiscal');
  assert.equal(sheetRecords(book, 'Snapshot')[0]['Fiscal Year'], 2026);
});

test('source formulas are written as literal text', () => {
  const book = new Workbook();
  const input = 'Evidence ID,Categories,Status,Date Uploaded,Owner Groups,Owner First Name\n0001,,Active,2026-10-13,HSI,=1+1\n';
  context.main(book, input, '2026-10-13', 'literal');
  assert.equal(sheetRecords(book, 'Uncategorized')[0]['Owner First Name'], "'=1+1");
});

test('complete Axon page bundle maps fields and preserves the synthetic label', () => {
  const book = new Workbook();
  const result = context.main(book, JSON.stringify(apiFixture), '2026-10-13', 'api_demo', '', false, 'axon-page-bundle');
  assert.equal(result.total_uncategorized, 8);
  assert.equal(result.critical, 4);
  assert.equal(result.rejected_rows, 3);
  assert.equal(result.sample_data, true);
  const snapshot = sheetRecords(book, 'Snapshot')[0];
  assert.equal(snapshot['Source Report'], 'EvidenceCreated');
  assert.equal(snapshot['Creation From Date'], apiFixture.from_date);
  assert.equal(snapshot['Creation To Date'], apiFixture.to_date);
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(snapshot[field], field === 'Blank Rows Removed' ? 0 : value, field);
  }
  const detail = sheetRecords(book, 'Uncategorized');
  assert.ok(detail.every(item => item['Evidence Serial Number'] === ''));
  assert.ok(detail.every(item => String(item['External Evidence ID']).startsWith('SYNTHETIC-EXTERNAL-')));
});

test('API partial acquisition cannot modify the workbook', () => {
  const incomplete = structuredClone(apiFixture);
  incomplete.pages.pop();
  const book = new Workbook();
  assert.throws(() => context.main(book, JSON.stringify(incomplete), '2026-10-13', 'partial', '', false, 'axon-page-bundle'), /Incomplete report/);
  assert.equal(book.writes, 0);
});

test('report page offset increments by one, never by page size', () => {
  const incorrect = structuredClone(apiFixture);
  incorrect.pages[1].page_offset = 50;
  const book = new Workbook();
  assert.throws(() => context.main(book, JSON.stringify(incorrect), '2026-10-13', 'offset', '', false, 'axon-page-bundle'), /contiguous/);
  assert.equal(book.writes, 0);
});

test('missing API categories fail instead of manufacturing uncategorized records', () => {
  const incorrect = structuredClone(apiFixture);
  delete incorrect.pages[0].data[0].categories;
  const book = new Workbook();
  assert.throws(() => context.main(book, JSON.stringify(incorrect), '2026-10-13', 'schema', '', false, 'axon-page-bundle'), /missing required API fields/);
  assert.equal(book.writes, 0);
});

test('a category literally named NULL remains assigned', () => {
  const assigned = structuredClone(apiFixture);
  assigned.pages = [{ page_offset: 0, data: [{ ...assigned.pages[0].data[0], categories: ['NULL'] }] }, { page_offset: 1, data: [] }];
  const book = new Workbook();
  const result = context.main(book, JSON.stringify(assigned), '2026-10-13', 'category', '', false, 'axon-page-bundle');
  assert.equal(result.total_uncategorized, 0);
  assert.equal(sheetRecords(book, 'Snapshot')[0]['Categorized Rows'], 1);
});

test('typed API names and external IDs are not CSV null-marker guesses', () => {
  const literal = structuredClone(apiFixture);
  literal.pages = [{ page_offset: 0, data: [{ ...literal.pages[0].data[0], ownerFirstName: 'Na', idExternal: 'NULL' }] }, { page_offset: 1, data: [] }];
  const book = new Workbook();
  context.main(book, JSON.stringify(literal), '2026-10-13', 'literal_api', '', false, 'axon-page-bundle');
  const detail = sheetRecords(book, 'Uncategorized')[0];
  assert.equal(detail['Owner First Name'], 'Na');
  assert.equal(detail['External Evidence ID'], 'NULL');
});

const pages = records => records.length ? [{ page_offset: 0, data: records }, { page_offset: 1, data: [] }] : [{ page_offset: 0, data: [] }];
const initialRefresh = JSON.parse(fs.readFileSync(path.join(root, 'examples/axon-backfill.sample.json'), 'utf8'));
const nextRefresh = JSON.parse(fs.readFileSync(path.join(root, 'examples/axon-incremental.sample.json'), 'utf8'));
function backfill() {
  const book = new Workbook();
  context.main(book, JSON.stringify(initialRefresh), '2026-10-13', 'initial', '', false, 'axon-refresh-bundle');
  return book;
}

test('backfill keeps all evidence state, including categorized records, in an eighth sheet', () => {
  const book = backfill();
  assert.equal(book.sheets.size, 8);
  assert.equal(sheetRecords(book, 'Evidence State').length, 4);
  assert.equal(sheetRecords(book, 'Uncategorized').length, 3);
  assert.equal(sheetRecords(book, 'Snapshot')[0]['Updated Through UTC'], '2026-10-13T10:00:00');
});

test('incremental refresh appends new IDs, updates categories/status, reopens records, and ages unchanged items', () => {
  const book = backfill();
  const result = context.main(book, JSON.stringify(nextRefresh), '2026-10-14', 'second', '', false, 'axon-refresh-bundle');
  assert.equal(result.total_uncategorized, 3);
  assert.equal(result.normal, 1);
  assert.equal(result.moderate, 1);
  assert.equal(result.critical, 1);
  assert.equal(result.sample_data, true); // A delta cannot remove the inherited synthetic-data label.
  const detail = sheetRecords(book, 'Uncategorized');
  assert.deepEqual(detail.map(row => row['Evidence ID']).sort(), ['aging', 'new', 'reopen']);
  assert.equal(detail.find(row => row['Evidence ID'] === 'aging')['Days Since Upload'], 15);
  assert.equal(sheetRecords(book, 'Evidence State').length, 5);
  const snap = sheetRecords(book, 'Snapshot')[0];
  assert.equal(snap['Out of Scope Updates'], 1);
  assert.equal(snap['Updated Through UTC'], '2026-10-14T10:00:00');
  assert.equal(snap['Previous Run ID'], 'initial');
});

test('empty incremental feeds retain the backlog and recalculate all ages', () => {
  const book = backfill();
  const empty = structuredClone(nextRefresh);
  empty.created.pages = pages([]); empty.updated.pages = pages([]);
  context.main(book, JSON.stringify(empty), '2026-10-14', 'empty_delta', '', false, 'axon-refresh-bundle');
  assert.equal(sheetRecords(book, 'Uncategorized').length, 3);
  assert.equal(sheetRecords(book, 'Uncategorized').find(row => row['Evidence ID'] === 'aging')['Days Since Upload'], 15);
});

test('stale bases, watermark gaps and changed scopes fail without changing the working workbook', () => {
  for (const change of [value => { value.previous_run_id = 'stale'; },
    value => { value.updated.updated_from_datetime = '2026-10-13T10:00:01'; },
    value => { value.creation_from_date = '2024-03-12'; },
    value => { value.created.from_date = '2026-10-14'; }]) {
    const book = backfill(), before = book.writes;
    const bad = structuredClone(nextRefresh); change(bad);
    assert.throws(() => context.main(book, JSON.stringify(bad), '2026-10-14', 'bad', '', false, 'axon-refresh-bundle'), /stale base/);
    assert.equal(book.writes, before);
  }
});

test('partial incremental acquisition never writes state or advances its watermark', () => {
  const book = backfill(), before = book.writes;
  const bad = structuredClone(nextRefresh); bad.updated.pages.pop();
  assert.throws(() => context.main(book, JSON.stringify(bad), '2026-10-14', 'partial', '', false, 'axon-refresh-bundle'), /Incomplete report/);
  assert.equal(book.writes, before);
  assert.equal(sheetRecords(book, 'Snapshot')[0]['Updated Through UTC'], '2026-10-13T10:00:00');
});

test('Updated category strings are rejected because the documented format uses objects', () => {
  const book = backfill(), before = book.writes;
  const bad = structuredClone(nextRefresh); bad.updated.pages[0].data[0].categories = ['case'];
  assert.throws(() => context.main(book, JSON.stringify(bad), '2026-10-14', 'shape', '', false, 'axon-refresh-bundle'), /category objects/);
  assert.equal(book.writes, before);
});

test('a delta cannot be applied to the blank template or a corrupted prior ledger', () => {
  assert.throws(() => context.main(new Workbook(), JSON.stringify(nextRefresh), '2026-10-14', 'blank', '', false, 'axon-refresh-bundle'), /no Snapshot/);
  const book = backfill(), before = book.writes;
  book.getWorksheet('Evidence State').values.pop();
  assert.throws(() => context.main(book, JSON.stringify(nextRefresh), '2026-10-14', 'corrupt', '', false, 'axon-refresh-bundle'), /row count/);
  assert.equal(book.writes, before);
});

test('missing recording-start date cannot silently expand or drop incremental scope', () => {
  const book = backfill(), before = book.writes;
  const bad = structuredClone(nextRefresh); delete bad.updated.pages[0].data[0].dateRecordStart;
  assert.throws(() => context.main(book, JSON.stringify(bad), '2026-10-14', 'scope', '', false, 'axon-refresh-bundle'), /recording-start/);
  assert.equal(book.writes, before);
});

test('read-only state script returns the previous identity and acquisition watermark without evidence rows', () => {
  const book = backfill(), before = book.writes;
  assert.deepEqual(plain(readContext.main(book)), {
    previous_run_id: 'initial', creation_from_date: '2024-03-11', creation_to_date: '2026-10-13',
    updated_through_utc: '2026-10-13T10:00:00', sample_data: true
  });
  assert.equal(book.writes, before);
});

test('read-only state script refuses workbooks without incremental API state', () => {
  assert.throws(() => readContext.main(new Workbook()), /published Snapshot/);
  const book = new Workbook(); context.main(book, fixture, '2026-10-13', 'csv');
  assert.throws(() => readContext.main(book), /API backfill/);
});

console.log(`${cases.length} Office Script checks passed using a workbook test double.`);

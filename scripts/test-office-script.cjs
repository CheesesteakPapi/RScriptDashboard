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
    const table = { name: '', delete: () => {}, setName: name => { table.name = name; }, setPredefinedTableStyle: () => {} };
    this.tables.push(table);
    return table;
  }
  getFreezePanes() { return { freezeRows: () => {} }; }
}
class Workbook {
  constructor() { this.sheets = new Map(); this.writes = 0; }
  getWorksheet(name) { return this.sheets.get(name); }
  addWorksheet(name) { const sheet = new Sheet(this, name); this.sheets.set(name, sheet); return sheet; }
}
const context = {
  ExcelScript: { ClearApplyTo: { all: 'all' }, ConditionalFormatType: { cellValue: 'cellValue' },
    ConditionalCellValueOperator: { greaterThan: 'greaterThan', between: 'between' } }
};
vm.createContext(context);
vm.runInContext(compiled.outputText, context);
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = fs.readFileSync(path.join(root, 'examples/evidence.sample.csv'), 'utf8');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'examples/expected-summary.json'), 'utf8'));
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

console.log(`${cases.length} Office Script checks passed using a workbook test double.`);

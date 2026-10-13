// Syntax verification with Microsoft's Power Query parser; this does not execute M.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const parserPath = process.argv[2] || '@microsoft/powerquery-parser';
let parser;
try {
  parser = require(parserPath);
} catch {
  console.error('Install @microsoft/powerquery-parser@2.0.0 and pass its absolute module path as the first argument.');
  process.exit(1);
}

(async () => {
  const folder = path.join(root, 'powerbi');
  for (const filename of fs.readdirSync(folder).filter(name => name.endsWith('.pq'))) {
    const result = await parser.TaskUtils.tryLexParse(parser.DefaultSettings,
      fs.readFileSync(path.join(folder, filename), 'utf8'));
    if (result.resultKind === 'Ok') {
      console.log(`PASS: ${filename}`);
    } else {
      const position = result.error.innerError?.foundToken?.token?.positionStart;
      console.error(`FAIL: ${filename}: ${result.error.message}`,
        position ? `at line ${position.lineNumber + 1}` : '');
      process.exitCode = 1;
    }
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

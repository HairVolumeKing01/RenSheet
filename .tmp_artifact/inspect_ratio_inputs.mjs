import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const files = [
  'D:/RenSheet/演示/均价不一致的拆配情况.xlsx',
  'D:/RenSheet/演示/均价不一致的拆配前的情况.xlsx',
];

for (const file of files) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
  const sheets = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 3000 });
  console.log('\nFILE', file);
  console.log(sheets.ndjson);
  const first = workbook.worksheets.getItemAt(0);
  const data = await workbook.inspect({
    kind: 'table',
    sheetId: first.name,
    range: 'A1:Z15',
    include: 'values,formulas',
    tableMaxRows: 15,
    tableMaxCols: 26,
    maxChars: 12000,
  });
  console.log(data.ndjson);
}

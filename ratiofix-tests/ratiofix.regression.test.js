const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.resolve(__dirname, '..', 'RatioFix.html');

function createElement(id = '') {
  const classes = new Set();
  return {
    id,
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      }
    },
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {},
    closest() { return null; },
    querySelectorAll() { return []; }
  };
}

function loadRatioFix() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i);
  assert.ok(match, '未找到 RatioFix.html 的主脚本');

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const storage = new Map();
  const document = {
    getElementById: getElement,
    querySelectorAll: () => [],
    querySelector: () => createElement('query-result'),
    createElement: (tag) => createElement(tag)
  };
  const context = vm.createContext({
    console,
    document,
    window: { scrollTo() {} },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    setTimeout,
    clearTimeout,
    FileReader: function FileReader() {},
    XLSX: {}
  });

  vm.runInContext(match[1], context, { filename: htmlPath });
  return { context, elements, storage, getElement };
}

function setState(context, state) {
  context.__testState = state;
  vm.runInContext(`
    characters = __testState.characters;
    pointsPerChar = __testState.pointsPerChar;
    originalPointsPerChar = __testState.originalPointsPerChar;
    originalPrices = __testState.originalPrices;
    baseAdjustments = __testState.baseAdjustments;
    rawHeatAdjustments = __testState.baseAdjustments;
    heatAdjustments = __testState.baseAdjustments;
    adjustments = __testState.adjustments;
    originalCharacterSet = __testState.originalCharacterSet;
    heatOrderConfirmed = true;
    avgPriceActual = __testState.avgPriceActual;
    avgPriceOrig = __testState.avgPriceOrig || __testState.avgPriceActual;
  `, context);
}

function makeRoleState({ roleCount, avgPriceActual, heatValues, originalPoints, pointDeltas }) {
  const characters = Array.from({ length: roleCount }, (_, index) => `R${String(index + 1).padStart(2, '0')}`);
  const state = {
    characters,
    pointsPerChar: {},
    originalPointsPerChar: {},
    originalPrices: {},
    baseAdjustments: {},
    adjustments: {},
    originalCharacterSet: {},
    avgPriceActual,
    avgPriceOrig: avgPriceActual
  };

  characters.forEach((ch, index) => {
    const base = heatValues[index];
    const originalPoint = originalPoints[index];
    state.pointsPerChar[ch] = originalPoint + pointDeltas[index];
    state.originalPointsPerChar[ch] = originalPoint;
    state.originalPrices[ch] = avgPriceActual + base;
    state.baseAdjustments[ch] = base;
    state.adjustments[ch] = base;
    state.originalCharacterSet[ch] = true;
  });

  assert.equal(
    Object.values(state.pointsPerChar).reduce((sum, value) => sum + value, 0),
    Object.values(state.originalPointsPerChar).reduce((sum, value) => sum + value, 0),
    '模拟排表应保持总点数一致'
  );
  return state;
}

function runAutoBalanceScenario(state, config) {
  const app = loadRatioFix();
  setState(app.context, state);
  app.context.__config = config;
  vm.runInContext(`
    applyBalanceRuleConfig(__config);
    autoBalance(false);
  `, app.context);

  return vm.runInContext(`({
    sum: computeSumProduct(),
    isBalanced,
    adjustments: Object.assign({}, adjustments),
    baseAdjustments: Object.assign({}, baseAdjustments),
    pointsPerChar: Object.assign({}, pointsPerChar),
    originalPointsPerChar: Object.assign({}, originalPointsPerChar),
    heatOrderOk: candidateKeepsConfirmedHeatOrder(Object.fromEntries(characters.map(function(ch) {
      return [ch, Math.round(adjustments[ch] * 100)];
    }))),
    balanceMode,
    unchangedRoleRulesOk: candidateKeepsUnchangedRoles(Object.fromEntries(characters.map(function(ch) {
      return [ch, Math.round(adjustments[ch] * 100)];
    }))),
    rows: characters.map(function(ch) {
      return {
        ch: ch,
        heatGroup: getHeatGroup(ch),
        gapCold: isGapColdRole(ch),
        pointDelta: (pointsPerChar[ch] || 0) - (originalPointsPerChar[ch] || 0),
        base: baseAdjustments[ch] || 0,
        adjustment: adjustments[ch] || 0,
        newPrice: avgPriceActual + (adjustments[ch] || 0)
      };
    }),
    resultText: document.getElementById('autoBalanceResult').textContent
  })`, app.context);
}

function makeWorkbook(data) {
  return {
    SheetNames: ['Sheet1'],
    Sheets: {
      Sheet1: { __data: data }
    }
  };
}

function installSheetToJson(context) {
  vm.runInContext(`
    XLSX.utils = {
      sheet_to_json: function(ws) { return ws.__data; },
      encode_cell: function(cell) {
        return String.fromCharCode(65 + cell.c) + String(cell.r + 1);
      }
    };
  `, context);
}

function makeValidWorkbook(kind = 'badge') {
  return makeWorkbook([
    [kind, '', ''],
    ['', 'A', 'B'],
    ['', 10, 20],
    ['', 'u1', 'u2']
  ]);
}

function assertBalancedScenario(result) {
  assert.equal(result.sum, 0);
  assert.equal(result.isBalanced, true);
  assert.equal(result.heatOrderOk, true);
  assert.ok(result.rows.every((row) => row.newPrice >= 0));
}

function assertColdRules(result) {
  result.rows.forEach((row) => {
    if (row.heatGroup !== 'cold') return;
    if (row.pointDelta > 0) assert.ok(row.adjustment <= row.base);
    if (row.pointDelta < 0 && row.gapCold) assert.ok(row.adjustment <= row.base);
    if (row.pointDelta < 0 && !row.gapCold) assert.ok(row.adjustment <= row.base + 5);
  });
}

function assertUnchangedRoleRules(result) {
  result.rows.forEach((row) => {
    if (row.pointDelta !== 0) return;
    assert.ok(row.adjustment <= row.base + 10);
  });
}

test('自动配平生成严格归零、非负且可恢复的方案', () => {
  const app = loadRatioFix();
  setState(app.context, {
    characters: ['热门', '冷门'],
    pointsPerChar: { 热门: 1, 冷门: 1 },
    originalPointsPerChar: { 热门: 1, 冷门: 1 },
    originalPrices: { 热门: 11, 冷门: 9 },
    baseAdjustments: { 热门: 1, 冷门: -1 },
    adjustments: { 热门: 1, 冷门: -1 },
    originalCharacterSet: { 热门: true, 冷门: true },
    avgPriceActual: 10
  });

  vm.runInContext('autoBalance(false)', app.context);

  const result = vm.runInContext(`({
    sum: computeSumProduct(),
    adjustments: Object.assign({}, adjustments),
    snapshot: Object.assign({}, autoBalanceSnapshot),
    isBalanced,
    newPrices: characters.map(function(ch) { return avgPriceActual + adjustments[ch]; })
  })`, app.context);
  assert.equal(result.sum, 0);
  assert.equal(result.isBalanced, true);
  assert.deepEqual(result.adjustments, result.snapshot);
  assert.ok(result.newPrices.every((price) => price >= 0));
});

test('自动配平后手动调价不会在 change 时按自动步长回退', () => {
  const app = loadRatioFix();
  setState(app.context, {
    characters: ['A', 'B'],
    pointsPerChar: { A: 1, B: 1 },
    originalPointsPerChar: { A: 0, B: 0 },
    originalPrices: { A: 11, B: 9 },
    baseAdjustments: { A: 1, B: -1 },
    adjustments: { A: 1, B: -1.23 },
    originalCharacterSet: { A: true, B: true },
    avgPriceActual: 10
  });
  vm.runInContext(`
    autoBalanceSnapshot = { A: 1, B: -1 };
    autoBalanceQuantumCents = 100;
  `, app.context);

  const input = createElement('adjustment-A');
  input.dataset.char = 'A';
  input.value = '1.23';
  app.context.__input = input;
  vm.runInContext('onAdjInput(__input); onAdjChange(__input)', app.context);

  assert.equal(input.value, '1.23');
  assert.equal(vm.runInContext('adjustments.A', app.context), 1.23);
  assert.equal(vm.runInContext('computeSumProduct()', app.context), 0);
  assert.equal(app.getElement('btnNext2').disabled, false);

  const draft = JSON.parse(app.storage.get('renshet_ratiofix_draft'));
  assert.equal(draft.adjustments.A, 1.23);
  assert.equal(draft.adjustments.B, -1.23);
});

test('手动调价未归零时禁止进入下一步', () => {
  const app = loadRatioFix();
  setState(app.context, {
    characters: ['A', 'B'],
    pointsPerChar: { A: 1, B: 1 },
    originalPointsPerChar: { A: 0, B: 0 },
    originalPrices: { A: 11, B: 9 },
    baseAdjustments: { A: 1, B: -1 },
    adjustments: { A: 1.24, B: -1.23 },
    originalCharacterSet: { A: true, B: true },
    avgPriceActual: 10
  });

  vm.runInContext('updateBalanceDisplay()', app.context);

  assert.equal(vm.runInContext('isBalanced', app.context), false);
  assert.equal(app.getElement('btnNext2').disabled, true);
  assert.equal(vm.runInContext('validateStep(2)', app.context), '请先调整调价使 Σ(点数×调价) = 0');
});
test('conservative custom limit rejects gap-hot over-limit balancing', () => {
  const app = loadRatioFix();
  setState(app.context, {
    characters: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    pointsPerChar: { A: 1, B: 1, C: 8, D: 5, E: 6, F: 12, G: 23 },
    originalPointsPerChar: { A: 8, B: 8, C: 8, D: 8, E: 8, F: 8, G: 8 },
    originalPrices: { A: 45, B: 45, C: 29, D: 25, E: 14, F: 12, G: 5 },
    baseAdjustments: { A: 20, B: 20, C: 4, D: 0, E: -11, F: -13, G: -20 },
    adjustments: { A: 20, B: 20, C: 4, D: 0, E: -11, F: -13, G: -20 },
    originalCharacterSet: { A: true, B: true, C: true, D: true, E: true, F: true, G: true },
    avgPriceActual: 25,
    avgPriceOrig: 25
  });

  vm.runInContext(`
    applyBalanceRuleConfig({ mode: 'conservative', range: 0.10, maxPriceMultiplier: 3, precision: 'default' });
    autoBalance(false);
  `, app.context);

  const result = vm.runInContext(`({
    sum: computeSumProduct(),
    isBalanced,
    adjustments: Object.assign({}, adjustments),
    heatOrderOk: candidateKeepsConfirmedHeatOrder(Object.fromEntries(characters.map(function(ch) {
      return [ch, Math.round(adjustments[ch] * 100)];
    })))
  })`, app.context);

  assert.equal(result.isBalanced, false);
  assert.equal(result.sum, -610);
  assert.ok(result.adjustments.A <= 50);
  assert.ok(result.adjustments.B <= 50);
  assert.ok(result.adjustments.C <= 14);
  assert.ok(result.adjustments.D <= 10);
  assert.ok(result.adjustments.E <= -6);
  assert.ok(result.adjustments.F <= -13);
  assert.ok(result.adjustments.G <= -20);
});

test('light mode locks following options and balances with soft heat constraint', () => {
  const app = loadRatioFix();
  setState(app.context, {
    characters: ['A', 'B', 'C'],
    pointsPerChar: { A: 1, B: 2, C: 3 },
    originalPointsPerChar: { A: 1, B: 2, C: 3 },
    originalPrices: { A: 60, B: 40, C: 20 },
    baseAdjustments: { A: 20, B: 0, C: -20 },
    adjustments: { A: 20, B: 0, C: -20 },
    originalCharacterSet: { A: true, B: true, C: true },
    avgPriceActual: 40,
    avgPriceOrig: 40
  });

  vm.runInContext(`
    applyBalanceRuleConfig({ mode: 'light', range: 1, maxPriceMultiplier: 10, precision: 'default' });
    autoBalance(false);
  `, app.context);

  const result = vm.runInContext(`({
    sum: computeSumProduct(),
    isBalanced,
    adjustments: Object.assign({}, adjustments),
    multiplierDisabled: document.getElementById('maxPriceMultiplierInput').disabled,
    precisionDisabled: document.getElementById('balancePrecision').disabled,
    resultText: document.getElementById('autoBalanceResult').textContent,
    newPrices: characters.map(function(ch) { return avgPriceActual + adjustments[ch]; })
  })`, app.context);

  assert.equal(result.sum, 0);
  assert.equal(result.isBalanced, true);
  assert.equal(result.multiplierDisabled, true);
  assert.equal(result.precisionDisabled, true);
  assert.match(result.resultText, /轻约束调平/);
  assert.ok(result.newPrices.every((price) => price >= 0));
});

test('five-step flow builds new prices and final refund table correctly', () => {
  const app = loadRatioFix();
  const originalWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 10, 20],
    ['', 'u1', 'u2']
  ]);
  const actualWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 10, 20],
    ['', 'u2', 'u1']
  ]);

  setState(app.context, {
    characters: ['A', 'B'],
    pointsPerChar: { A: 1, B: 1 },
    originalPointsPerChar: { A: 1, B: 1 },
    originalPrices: { A: 10, B: 20 },
    baseAdjustments: { A: -5, B: 5 },
    adjustments: { A: -5, B: 5 },
    originalCharacterSet: { A: true, B: true },
    avgPriceActual: 15,
    avgPriceOrig: 15
  });

  app.context.__originalWorkbook = originalWorkbook;
  app.context.__actualWorkbook = actualWorkbook;
  installSheetToJson(app.context);
  vm.runInContext(`
    originalFile = { workbook: __originalWorkbook };
    actualFile = { workbook: __actualWorkbook };
    kindName = 'badge';
    currentTheme = 'blue';
    document.getElementById('rFileName').value = '二调退补表';
    buildNewPriceSheet();
    computeAndRenderFinal();
  `, app.context);

  const result = JSON.parse(vm.runInContext(`JSON.stringify({
    newPrices: Object.assign({}, newPrices),
    finalRows: buildFinalListTable(finalTableData).rows,
    persons: finalTableData.persons.slice(),
    finalPreviewHtml: document.getElementById('finalPreview').innerHTML,
    summaryHtml: document.getElementById('summaryTable').innerHTML
  })`, app.context));

  assert.deepEqual(result.newPrices, { A: 10, B: 20 });
  assert.deepEqual(result.persons, ['u1', 'u2']);
  assert.deepEqual(result.finalRows, [
    ['u1', 'badge-B1', 1, 10, 20, -10],
    ['u2', 'badge-A1', 1, 20, 10, 10]
  ]);
  assert.match(result.finalPreviewHtml, /补款 1 人/);
  assert.match(result.finalPreviewHtml, /退款 1 人/);
  assert.match(result.summaryHtml, /10\.00/);
  assert.match(result.summaryHtml, /20\.00/);
});

test('step 1 rejects non-positive total points before parsing totals', () => {
  const app = loadRatioFix();
  const originalWorkbook = makeValidWorkbook();
  const actualWorkbook = makeValidWorkbook();

  installSheetToJson(app.context);
  app.context.__originalWorkbook = originalWorkbook;
  app.context.__actualWorkbook = actualWorkbook;
  vm.runInContext(`
    originalFile = { name: 'orig.xlsx', workbook: __originalWorkbook };
    actualFile = { name: 'actual.xlsx', workbook: __actualWorkbook };
    document.getElementById('avgPriceActual').value = '15';
    document.getElementById('totalPoints').value = '0';
  `, app.context);

  assert.equal(vm.runInContext('validateStep(1)', app.context), '请输入拆配表总点数（用于双重校验）');
});

test('step 1 keeps original average independent and rejects a mismatched actual average', () => {
  const app = loadRatioFix();
  const originalWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 10, 20],
    ['', 'u1', 'u2'],
    ['', '', 'u3']
  ]);
  const actualWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 1, 1],
    ['', 'u1', 'u2'],
    ['', '', 'u3']
  ]);

  installSheetToJson(app.context);
  app.context.__originalWorkbook = originalWorkbook;
  app.context.__actualWorkbook = actualWorkbook;
  vm.runInContext(`
    originalFile = { name: 'orig.xlsx', workbook: __originalWorkbook };
    actualFile = { name: 'actual.xlsx', workbook: __actualWorkbook };
    document.getElementById('avgPriceActual').value = '20';
    document.getElementById('totalPoints').value = '3';
  `, app.context);

  const result = vm.runInContext(`({
    error: validateStep(1),
    originalAverage: avgPriceOrig,
    originalAverageDisplay: document.getElementById('avgPriceOrig').value
  })`, app.context);

  assert.equal(result.originalAverage, 50 / 3);
  assert.equal(result.originalAverageDisplay, '16.66667');
  assert.match(result.error, /跨表总价校验不通过/);
  assert.match(result.error, /原排表检测均价 16\.66667/);
});

test('full refund flow uses original prices and independently verified averages', () => {
  const app = loadRatioFix();
  const originalWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 10, 25],
    ['', 'u1', ''],
    ['', 'u2', 'u3'],
    ['', '', 'u4']
  ]);
  const actualWorkbook = makeWorkbook([
    ['badge', '', ''],
    ['', 'A', 'B'],
    ['', 0, 0],
    ['', '', 'u1'],
    ['', 'u2', ''],
    ['', 'u3', 'u4']
  ]);

  installSheetToJson(app.context);
  app.context.__originalWorkbook = originalWorkbook;
  app.context.__actualWorkbook = actualWorkbook;
  vm.runInContext(`
    originalFile = { name: 'orig.xlsx', workbook: __originalWorkbook };
    actualFile = { name: 'actual.xlsx', workbook: __actualWorkbook };
    document.getElementById('avgPriceActual').value = '17.5';
    document.getElementById('totalPoints').value = '4';
  `, app.context);

  assert.equal(vm.runInContext('validateStep(1)', app.context), null);
  vm.runInContext(`
    buildBalancer();
    heatOrderConfirmed = true;
    adjustments.A = 10 - avgPriceActual;
    adjustments.B = 25 - avgPriceActual;
    updateBalanceDisplay();
    buildNewPriceSheet();
    computeAndRenderFinal();
  `, app.context);

  const result = JSON.parse(vm.runInContext(`JSON.stringify({
    average: avgPriceOrig,
    isBalanced: isBalanced,
    originalTotal: Object.values(originalShenMap).reduce(function(sum, row) { return sum + row.totalCost; }, 0),
    actualTotal: Object.values(actualShenMap).reduce(function(sum, row) { return sum + row.totalCost; }, 0),
    rows: buildFinalListTable(finalTableData).rows,
    preview: document.getElementById('finalPreview').innerHTML
  })`, app.context));

  assert.equal(result.average, 17.5);
  assert.equal(result.isBalanced, true);
  assert.equal(result.originalTotal, 70);
  assert.equal(result.actualTotal, 70);
  assert.deepEqual(result.rows, [
    ['u1', 'badge-B1', 1, 10, 25, -15],
    ['u2', 'badge-A1', 1, 10, 10, 0],
    ['u3', 'badge-A1', 1, 25, 10, 15],
    ['u4', 'badge-B1', 1, 25, 25, 0]
  ]);
  assert.match(result.preview, /参数总额校验通过/);
});

test('step 1 point mismatch renders parse diagnostics with cell-level causes', () => {
  const app = loadRatioFix();
  const originalWorkbook = makeValidWorkbook();
  const actualWorkbook = makeWorkbook([
    ['badge', '', '', ''],
    ['', 'A', '', 'B'],
    ['', 10, '', 20],
    ['', 'u1', 'lost', 'u2']
  ]);

  installSheetToJson(app.context);
  app.context.__originalWorkbook = originalWorkbook;
  app.context.__actualWorkbook = actualWorkbook;
  vm.runInContext(`
    originalFile = { name: 'orig.xlsx', workbook: __originalWorkbook };
    actualFile = { name: 'actual.xlsx', workbook: __actualWorkbook };
    document.getElementById('avgPriceActual').value = '15';
    document.getElementById('totalPoints').value = '3';
  `, app.context);

  const result = vm.runInContext(`({
    error: validateStep(1),
    panelDisplay: document.getElementById('step1ParseErrorPanel').style.display,
    panelHtml: document.getElementById('step1ParseErrorPanel').innerHTML
  })`, app.context);

  assert.match(result.error, /拆配排表解析失败/);
  assert.equal(result.panelDisplay, 'block');
  assert.match(result.panelHtml, /数据列缺少角色名/);
  assert.match(result.panelHtml, /C2/);
});

test('file import rejects unsupported extension without mutating file state', () => {
  const app = loadRatioFix();
  const tag = createElement('tag');
  const dz = createElement('dropzone');

  app.context.__file = { name: 'actual.csv' };
  app.context.__tag = tag;
  app.context.__dz = dz;
  vm.runInContext('handleFile(__file, false, __tag, __dz)', app.context);

  const result = vm.runInContext(`({
    actualFile: actualFile,
    toastText: document.getElementById('toast').textContent,
    toastClass: document.getElementById('toast').className
  })`, app.context);

  assert.equal(result.actualFile, null);
  assert.equal(result.toastText, '仅支持 .xlsx 文件');
  assert.match(result.toastClass, /error/);
  assert.equal(tag.innerHTML, '');
  assert.equal(dz.style.borderColor, undefined);
});

test('file reader errors are reported without saving a partial workbook', () => {
  const app = loadRatioFix();
  const tag = createElement('tag');
  const dz = createElement('dropzone');

  app.context.__file = { name: 'actual.xlsx' };
  app.context.__tag = tag;
  app.context.__dz = dz;
  vm.runInContext(`
    FileReader = function FileReader() {
      this.readAsArrayBuffer = function() { this.onerror(); };
    };
    handleFile(__file, false, __tag, __dz);
  `, app.context);

  const result = vm.runInContext(`({
    actualFile: actualFile,
    toastText: document.getElementById('toast').textContent,
    toastClass: document.getElementById('toast').className
  })`, app.context);

  assert.equal(result.actualFile, null);
  assert.equal(result.toastText, '文件「actual.xlsx」读取失败');
  assert.match(result.toastClass, /error/);
  assert.equal(tag.innerHTML, '');
});

test('draft persistence tolerates denied storage access', () => {
  const app = loadRatioFix();

  vm.runInContext(`
    localStorage = {
      getItem: function() { throw new Error('denied'); },
      setItem: function() { throw new Error('denied'); },
      removeItem: function() { throw new Error('denied'); }
    };
  `, app.context);

  assert.doesNotThrow(() => vm.runInContext('saveDraft()', app.context));
  assert.equal(vm.runInContext('restoreDraft()', app.context), false);
  assert.doesNotThrow(() => vm.runInContext('clearDraft()', app.context));
});

test('restore draft keeps workbook permissions reset while syncing parameters', () => {
  const app = loadRatioFix();
  const saved = {
    savedAt: Date.now(),
    currentTheme: 'green',
    origFileName: 'orig.xlsx',
    actualFileName: 'actual.xlsx',
    fileName: 'custom refund',
    avgPriceOrig: 12.34567,
    avgPriceActual: 13.5,
    totalPointsInput: 2,
    balanceMode: 'light',
    balanceRange: 1,
    balanceMaxPriceMultiplier: 9,
    balancePrecision: '100'
  };
  app.storage.set('renshet_ratiofix_draft', JSON.stringify(saved));

  const restored = vm.runInContext('restoreDraft()', app.context);
  const result = vm.runInContext(`({
    originalFile: originalFile,
    actualFile: actualFile,
    origTag: tagOriginal.innerHTML,
    actualTag: tagActual.innerHTML,
    origBorder: dzOriginal.style.borderColor,
    actualBorder: dzActual.style.borderColor,
    fileName: document.getElementById('rFileName').value,
    avgActual: document.getElementById('avgPriceActual').value,
    totalPoints: document.getElementById('totalPoints').value,
    mode: balanceMode,
    precision: balancePrecision
  })`, app.context);

  assert.equal(restored, true);
  assert.equal(result.originalFile, null);
  assert.equal(result.actualFile, null);
  assert.match(result.origTag, /需重新上传文件/);
  assert.match(result.actualTag, /需重新上传文件/);
  assert.equal(result.origBorder, '#FBBF24');
  assert.equal(result.actualBorder, '#FBBF24');
  assert.equal(result.fileName, 'custom refund');
  assert.equal(result.avgActual, 13.5);
  assert.equal(result.totalPoints, 2);
  assert.equal(result.mode, 'light');
  assert.equal(result.precision, 'default');
});

test('spread mode balances 16-role large hot-to-cold point shift', () => {
  const state = makeRoleState({
    roleCount: 16,
    avgPriceActual: 30,
    heatValues: [30, 24, 18, 15, 12, 9, 6, 3, -3, -6, -9, -12, -15, -18, -21, -24],
    originalPoints: Array(16).fill(8),
    pointDeltas: [-6, -6, -4, -3, -2, -1, 0, 0, 0, 1, 2, 3, 4, 5, 3, 4]
  });

  const result = runAutoBalanceScenario(state, {
    mode: 'spread',
    range: 1,
    maxPriceMultiplier: 10,
    precision: '100'
  });

  assertBalancedScenario(result);
  assertColdRules(result);
  assertUnchangedRoleRules(result);
  const changedCount = result.rows.filter((row) => row.adjustment !== row.base).length;
  assert.ok(changedCount >= 6);
});

test('spread mode uses unchanged middle roles when many end roles are constrained', () => {
  const state = makeRoleState({
    roleCount: 20,
    avgPriceActual: 28,
    heatValues: [22, 20, 18, 16, 12, 9, 6, 3, 1, 0, 0, -1, -3, -6, -9, -12, -16, -18, -20, -22],
    originalPoints: Array(20).fill(6),
    pointDeltas: [-5, -4, -3, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 4, 5]
  });

  const result = runAutoBalanceScenario(state, {
    mode: 'spread',
    range: 1,
    maxPriceMultiplier: 8,
    precision: '100'
  });

  assertBalancedScenario(result);
  assertColdRules(result);
  assertUnchangedRoleRules(result);
  const unchangedMiddleChanged = result.rows.filter((row) =>
    row.pointDelta === 0 && row.heatGroup === 'middle' && row.adjustment !== row.base
  ).length;
  assert.ok(unchangedMiddleChanged >= 1);
});

test('spread mode balances 24-role dense schedule without timing out', () => {
  const state = makeRoleState({
    roleCount: 24,
    avgPriceActual: 32,
    heatValues: [30, 24, 18, 15, 12, 9, 6, 3, 1, 0, 0, 0, 0, 0, 0, 0, -3, -6, -9, -12, -15, -18, -21, -24],
    originalPoints: Array(24).fill(8),
    pointDeltas: [-6, -6, -4, -3, -2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 3, 4]
  });

  const result = runAutoBalanceScenario(state, {
    mode: 'spread',
    range: 1,
    maxPriceMultiplier: 10,
    precision: '100'
  });

  assertBalancedScenario(result);
  assertColdRules(result);
  assertUnchangedRoleRules(result);
});

test('连续排在最前的新增角色优先且按贡献均分，插入角色不享有优先级', () => {
  const app = loadRatioFix();
  app.context.__state = {
    characters: ['新增A', '新增B', '原角色', '插入新增'],
    pointsPerChar: { 新增A: 2, 新增B: 2, 原角色: 4, 插入新增: 1 },
    originalPointsPerChar: { 新增A: 0, 新增B: 0, 原角色: 6, 插入新增: 0 },
    originalPrices: { 原角色: 12 },
    baseAdjustments: { 新增A: 0, 新增B: 0, 原角色: -1, 插入新增: 0 },
    adjustments: { 新增A: 0, 新增B: 0, 原角色: -1, 插入新增: 0 },
    originalCharacterSet: { 原角色: true },
    avgPriceActual: 10,
    avgPriceOrig: 10
  };
  vm.runInContext(`
    characters = __state.characters;
    pointsPerChar = __state.pointsPerChar;
    originalPointsPerChar = __state.originalPointsPerChar;
    originalPrices = __state.originalPrices;
    baseAdjustments = __state.baseAdjustments;
    adjustments = __state.adjustments;
    originalCharacterSet = __state.originalCharacterSet;
    heatOrderConfirmed = true;
    avgPriceActual = __state.avgPriceActual;
    avgPriceOrig = __state.avgPriceOrig;
  `, app.context);

  const result = vm.runInContext(`({
    roles: getPriorityNewRoles(),
    equal: getPriorityNewRoleScore({新增A:100, 新增B:100, 原角色:-100, 插入新增:-100}),
    uneven: getPriorityNewRoleScore({新增A:200, 新增B:0, 原角色:-100, 插入新增:-100})
  })`, app.context);

  assert.deepEqual(Array.from(result.roles), ['新增A', '新增B']);
  assert.equal(result.equal.uncovered, 0);
  assert.equal(result.equal.spread, 0);
  assert.ok(result.uneven.spread > result.equal.spread);
});

test('轻约束可对多角色精确配平并保持确认的调价热度排序', () => {
  const state = {
    characters: ['特典', '樱', '苏', '桐生', '梶莲', '榆', '杉下', '大河'],
    pointsPerChar: { 特典: 8, 樱: 6, 苏: 7, 桐生: 8, 梶莲: 8, 榆: 9, 杉下: 9, 大河: 9 },
    originalPointsPerChar: { 特典: 0, 樱: 8, 苏: 8, 桐生: 8, 梶莲: 8, 榆: 8, 杉下: 8, 大河: 8 },
    originalPrices: { 特典: 21.88, 樱: 41.88, 苏: 41.88, 桐生: 25.88, 梶莲: 21.88, 榆: 10.88, 杉下: 8.88, 大河: 1.88 },
    baseAdjustments: { 特典: 0, 樱: 20, 苏: 20, 桐生: 4, 梶莲: 0, 榆: -11, 杉下: -13, 大河: -20 },
    adjustments: { 特典: 0, 樱: 20, 苏: 20, 桐生: 4, 梶莲: 0, 榆: -11, 杉下: -13, 大河: -20 },
    originalCharacterSet: { 樱: true, 苏: true, 桐生: true, 梶莲: true, 榆: true, 杉下: true, 大河: true },
    avgPriceActual: 21.88,
    avgPriceOrig: 21.88
  };
  const result = runAutoBalanceScenario(state, { mode: 'light', range: 1, maxPriceMultiplier: 10, precision: 'default' });
  assertBalancedScenario(result);
  assert.ok(result.adjustments.特典 >= result.adjustments.樱);
  assert.ok(result.adjustments.樱 >= result.adjustments.苏);
});

test('首位新增角色的排序基线不会再把同锚点原角色拉高后抵消', () => {
  const state = {
    characters: ['New', 'Cherry', 'Su', 'Kiryuu', 'Kajiren', 'Yuu', 'Sugishita', 'Taiga'],
    pointsPerChar: { New: 8, Cherry: 6, Su: 7, Kiryuu: 8, Kajiren: 8, Yuu: 9, Sugishita: 9, Taiga: 9 },
    originalPointsPerChar: { New: 0, Cherry: 8, Su: 8, Kiryuu: 8, Kajiren: 8, Yuu: 8, Sugishita: 8, Taiga: 8 },
    originalPrices: { Cherry: 41.88, Su: 41.88, Kiryuu: 25.88, Kajiren: 21.88, Yuu: 10.88, Sugishita: 8.88, Taiga: 1.88 },
    baseAdjustments: { New: 0, Cherry: 20, Su: 20, Kiryuu: 4, Kajiren: 0, Yuu: -11, Sugishita: -13, Taiga: -20 },
    adjustments: { New: 0, Cherry: 20, Su: 20, Kiryuu: 4, Kajiren: 0, Yuu: -11, Sugishita: -13, Taiga: -20 },
    originalCharacterSet: { Cherry: true, Su: true, Kiryuu: true, Kajiren: true, Yuu: true, Sugishita: true, Taiga: true },
    avgPriceActual: 21.88,
    avgPriceOrig: 21.88
  };

  ['default', 'spread', 'light'].forEach((mode) => {
    const result = runAutoBalanceScenario(state, { mode, range: 1, maxPriceMultiplier: 10, precision: 'default' });
    assertBalancedScenario(result);
    assert.ok(result.adjustments.New <= 2000, `${mode} 不应将新增角色推高超过 +20 基线`);
    assert.ok(result.adjustments.Cherry <= 2000, `${mode} 不应将樱拉高超过原调价 +20`);
    assert.ok(Math.abs(result.adjustments.Cherry - result.adjustments.Su) <= 100, `${mode} 应保护樱、苏的同原调价锚点`);
  });

  const conservativeState = JSON.parse(JSON.stringify(state));
  conservativeState.adjustments = Object.assign({}, conservativeState.baseAdjustments);
  const conservative = runAutoBalanceScenario(conservativeState, { mode: 'conservative', range: 0.1, maxPriceMultiplier: 10, precision: 'default' });
  assert.equal(conservative.balanceMode, 'conservative');
  assert.equal(conservative.unchangedRoleRulesOk, true);
  assertBalancedScenario(conservative);
  assert.equal(conservative.adjustments.Kiryuu, 4);
  assert.equal(conservative.adjustments.Kajiren, 0);
});

test('点数未变化角色可手动微调，但自动规则仍保持其原调价', () => {
  const app = loadRatioFix();
  const state = {
    characters: ['Hot', 'Stable', 'Cold'],
    pointsPerChar: { Hot: 7, Stable: 8, Cold: 9 },
    originalPointsPerChar: { Hot: 8, Stable: 8, Cold: 8 },
    originalPrices: { Hot: 30, Stable: 20, Cold: 10 },
    baseAdjustments: { Hot: 10, Stable: 0, Cold: -10 },
    adjustments: { Hot: 10, Stable: 0, Cold: -10 },
    originalCharacterSet: { Hot: true, Stable: true, Cold: true },
    avgPriceActual: 20
  };
  setState(app.context, state);
  vm.runInContext('renderBalancer()', app.context);
  const html = app.getElement('balancerWrap').innerHTML;
  assert.match(html, /data-char="Stable"/);
  assert.doesNotMatch(html, /data-char="Stable"[^>]*readonly/);
  assert.match(html, /自动配平保持原调价；可手动微调/);

  ['default', 'conservative'].forEach((mode) => {
    const result = runAutoBalanceScenario(state, { mode, range: 0.1, maxPriceMultiplier: 3, precision: 'default' });
    assert.equal(result.adjustments.Stable, 0);
  });
});

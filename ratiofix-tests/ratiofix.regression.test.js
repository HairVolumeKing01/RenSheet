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
  vm.runInContext(`
    XLSX.utils = {
      sheet_to_json: function(ws) { return ws.__data; }
    };
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

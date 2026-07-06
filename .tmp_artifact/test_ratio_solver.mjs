import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('D:/RenSheet/RatioFix.html', 'utf8');
const functionNames = [
  'clampInt', 'getRolePriceQuantum', 'getPriorityNewRoles', 'getPriorityNewRoleGapCents',
  'candidateKeepsPriorityNewPrices', 'candidateKeepsConfirmedHeatOrder', 'candidateRespectsColdestPointIncrease',
  'candidateKeepsUnchangedRoles', 'candidateRaisesPriorityNewRoles', 'isEffectiveSwitchPair',
  'getPointChangeProfile', 'getHeatGroup', 'getTierConfig', 'createAutoPolicy', 'createGapFallbackPolicy',
  'getHeatGapFallbackRolePlans',
  'getRoleAdjustmentBounds', 'normalizeAdjustmentForRole', 'alignAdjustmentToQuantum',
  'buildPreferredAutoAdjustments', 'getRelaxPenalty', 'solveExactMultiRoleAtPolicy',
  'collectGapFallbackCandidates', 'solveExactMultiRole',
];

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`缺少函数：${name}`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`函数未闭合：${name}`);
}

const context = {
  console,
  Math,
  Number,
  Object,
  Array,
  characters: ['热', '冷'],
  pointsPerChar: {热: 1, 冷: 1},
  originalPointsPerChar: {热: 2, 冷: 2},
  originalPrices: {热: 1, 冷: 1},
  baseAdjustments: {热: 0.2, 冷: -0.2},
  heatAdjustments: {热: 0.2, 冷: -0.2},
  originalCharacterSet: {热: true, 冷: true},
  missingOriginalCharacters: [],
  avgPriceActual: 10,
  activeAutoPolicy: null,
  activeAutoQuantumCents: 1,
};
vm.createContext(context);
vm.runInContext(functionNames.map(extractFunction).join('\n\n'), context);

const profile = context.getPointChangeProfile();
const preferred = context.buildPreferredAutoAdjustments(profile);
const solutions = [];
for (let i = 0; i < 20; i++) {
  const solved = context.solveExactMultiRole(preferred, i, profile);
  if (!solved || i >= solved.available) break;
  solutions.push(solved);
}

if (!solutions.length) throw new Error('未生成候选方案');
if (solutions.length > 20) throw new Error('候选方案超过20条');
const quantums = solutions.map((item) => item.quantumCents);
const order = {100: 0, 10: 1, 1: 2};
for (let i = 1; i < quantums.length; i++) {
  if (order[quantums[i]] < order[quantums[i - 1]]) throw new Error('候选精度顺序错误');
}
for (const solved of solutions) {
  const sum = context.characters.reduce((total, ch) => total + context.pointsPerChar[ch] * solved.values[ch], 0);
  if (sum !== 0) throw new Error('候选方案未严格归零');
  for (const ch of context.characters) {
    const base = Math.round(context.baseAdjustments[ch] * 100);
    if ((solved.values[ch] - base) % solved.quantumCents !== 0) throw new Error('候选方案未按原调价步长变化');
  }
}
const unique = new Set(solutions.map((item) => context.characters.map((ch) => item.values[ch]).join(',')));
if (unique.size !== solutions.length) throw new Error('候选方案存在重复');
if (!quantums.includes(100) || !quantums.includes(1)) throw new Error(`候选精度补足异常：${quantums.join(',')}`);

console.log(`通过：生成 ${solutions.length} 条去重候选`);
console.log(`通过：精度顺序 ${quantums.join(' → ')}`);
console.log('通过：全部方案严格归零并以原调价为步长锚点');

// Regression case based on the user's screenshot with the unchanged 梶莲 role.
context.characters = ['苏', '樱', '桐生', '梶莲', '榆', '杉下', '大河'];
context.pointsPerChar = {苏: 6, 樱: 1, 桐生: 11, 梶莲: 8, 榆: 6, 杉下: 9, 大河: 15};
context.originalPointsPerChar = {苏: 8, 樱: 8, 桐生: 8, 梶莲: 8, 榆: 8, 杉下: 8, 大河: 8};
context.originalPrices = {苏: 45, 樱: 45, 桐生: 29, 梶莲: 25, 榆: 14, 杉下: 12, 大河: 5};
context.baseAdjustments = {苏: 20, 樱: 20, 桐生: 4, 梶莲: 0, 榆: -11, 杉下: -13, 大河: -20};
context.heatAdjustments = {苏: 20, 樱: 13.33, 桐生: 6.67, 梶莲: 0, 榆: -6.67, 杉下: -13.33, 大河: -20};
context.originalCharacterSet = {苏: true, 樱: true, 桐生: true, 梶莲: true, 榆: true, 杉下: true, 大河: true};
context.missingOriginalCharacters = [];
context.avgPriceActual = 25;
const actualProfile = context.getPointChangeProfile();
const actualPreferred = context.buildPreferredAutoAdjustments(actualProfile);
const actualSolved = context.solveExactMultiRole(actualPreferred, 0, actualProfile);
if (!actualSolved) throw new Error('用户回归数据未生成断层兜底方案');
if (actualSolved.fallbackType !== 'heat-gap') throw new Error('用户回归数据未标记热度断层兜底');
if (!context.candidateKeepsConfirmedHeatOrder(actualSolved.values)) throw new Error('断层兜底破坏了热度顺序');
if (!context.candidateRespectsColdestPointIncrease(actualSolved.values)) throw new Error('最冷增点角色未下调');
const fallbackSum = context.characters.reduce((total, ch) => total + context.pointsPerChar[ch] * actualSolved.values[ch], 0);
if (fallbackSum !== 0) throw new Error('断层兜底未严格归零');
const fallbackCandidates = context.collectGapFallbackCandidates(actualPreferred, actualProfile, 3);
fallbackCandidates.forEach((candidate, index) => {
  if (candidate.values['大河'] >= -2000) throw new Error(`候选 ${index + 1} 未下调最冷的大河`);
  if (candidate.values['梶莲'] !== 0) throw new Error(`候选 ${index + 1} 修改了点数未变的梶莲`);
});
const invalidScreenshotValues = {苏: 4250, 樱: 4250, 桐生: 450, 梶莲: 1250, 榆: -400, 杉下: -1400, 大河: -1980};
if (context.candidateKeepsConfirmedHeatOrder(invalidScreenshotValues)) throw new Error('截图中的热度倒挂方案未被拒绝');
context.activeAutoPolicy = context.createAutoPolicy(actualProfile, 3);
const unchangedBounds = context.getRoleAdjustmentBounds('梶莲');
const changedBounds = context.getRoleAdjustmentBounds('苏');
context.activeAutoPolicy = null;
if (unchangedBounds.max !== 0 || unchangedBounds.min !== 0) throw new Error('点数未变角色未锁定原调价');
if (changedBounds.max !== 4250) throw new Error('点数变化角色未应用50%上限');
const allRoles = context.characters.slice();
context.activeAutoPolicy = context.createGapFallbackPolicy(actualProfile, allRoles, 3);
const threeTimesBounds = context.getRoleAdjustmentBounds('苏');
context.activeAutoPolicy = context.createGapFallbackPolicy(actualProfile, allRoles, 4);
const fourTimesBounds = context.getRoleAdjustmentBounds('苏');
context.activeAutoPolicy = null;
if (threeTimesBounds.max !== 5000 || fourTimesBounds.max !== 7500) throw new Error('3倍/4倍新单价边界错误');
console.log(`通过：用户回归数据生成热度断层兜底，${actualSolved.available} 条候选`);
console.log('回归首选：' + context.characters.map((ch) => `${ch}=${actualSolved.values[ch] / 100}`).join('，'));
console.log('通过：全部候选均下调增加7点的最冷角色大河');
console.log('通过：截图中的热度倒挂方案已被拒绝');
console.log('通过：所有候选均锁定点数未变的梶莲为原调价0');
console.log('通过：未变角色边界已锁定，变化角色最终层50%上限');
console.log('通过：断层兜底先限3倍，4倍极限边界可用');

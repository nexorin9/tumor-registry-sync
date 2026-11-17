/**
 * 产物核验：检查收尾采集脚本留下的真实运行产物是否齐全、push 是否成功。
 * 仅读取 round 根目录 logs/ 与 docs/screenshots/，不改动任何产品代码。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROUND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOGS = join(ROUND_ROOT, 'logs');
const SHOTS = join(PROJECT_DIR, 'docs', 'screenshots');

const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  PASS', name);
  } else {
    console.log('  FAIL', name, detail ? `(${detail})` : '');
    failures.push(name);
  }
}

console.log('VERIFY ARTIFACTS');
console.log('  logs dir :', LOGS);
console.log('  shots dir:', SHOTS);

// 1) 五个命令的真实终端会话原文
const trNames = ['01-doctor', '02-sheet', '03-align', '04-push', '05-summary'];
for (const n of trNames) {
  const p = join(LOGS, `tr-${n}.txt`);
  check(`transcript tr-${n}.txt`, existsSync(p) && statSync(p).size > 0, p);
}

// 2) 六张真实运行 SVG 截图
const svgs = ['doctor.svg', 'sheet.svg', 'align.svg', 'push.svg', 'summary.svg', 'result-table.svg'];
for (const s of svgs) {
  const p = join(SHOTS, s);
  check(`screenshot ${s}`, existsSync(p) && statSync(p).size > 0, p);
}

// 3) push 结果：ok 且 pushed>=1 且 failed===0
const pushPath = join(LOGS, 'demo-push-result.json');
try {
  const j = JSON.parse(readFileSync(pushPath, 'utf8'));
  const s = j.result.summary;
  check('push envelope ok', j.ok === true);
  check('push pushed >= 1', s.pushed >= 1, `pushed=${s.pushed}`);
  check('push failed === 0', s.failed === 0, `failed=${s.failed}`);
} catch (e) {
  check('push result parse', false, String(e));
}

// 4) 结果表 CSV：含五列新列（院内值 / 差异 / 建议值 / 确认 / AI 说明）
const csvPath = join(LOGS, 'demo-result-table-fragment.csv');
try {
  const txt = readFileSync(csvPath, 'utf8');
  const header = txt.split('\n')[0];
  const cols = header.split(',').length;
  check('result csv header >= 10 cols', cols >= 10, `cols=${cols}`);
  check('result csv has 院内值', header.includes('院内值'));
  check('result csv has 差异', header.includes('差异'));
  check('result csv has 建议值', header.includes('建议值'));
} catch (e) {
  check('result csv parse', false, String(e));
}

console.log('');
if (failures.length) {
  console.log(`ARTIFACT VERIFY FAILED: ${failures.length} issue(s) -> ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ARTIFACT VERIFY PASSED');

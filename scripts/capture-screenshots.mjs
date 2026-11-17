/**
 * 采集真实运行截图素材（仅用于 docs/screenshots 与 logs，不进产品运行路径）。
 *
 * 做法：起两个**真的**本地 HTTP 替身（假 CDR / 假专病库），把生产代码 CLI 的环境变量
 * 指向它们，然后像真实用户一样跑 `doctor / sheet / align / push / summary`。
 * 所有输出都是生产代码（dist/cli.js）的真实产出，不是设计稿、不是概念图。
 *
 * 脱敏：样例登记号一律用 REG-DEMO-* 占位标识，不含任何患者可识别明报。
 *
 * 输出：每个命令的真实终端会话原文落 round 根目录 logs/tr-*.txt；另导出对齐结果表 CSV。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROUND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOGS_DIR = join(ROUND_ROOT, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

// ───────────────────────── 脱敏样例登记表 ─────────────────────────
const DEMO_CSV = `登记号,分期,治疗方案,随访电话,生活方式备注
REG-DEMO-001,II,术后辅助化疗,138****0001,吸烟史
REG-DEMO-002,IIIA,新辅助化疗,138****0002,戒烟
REG-DEMO-003,IV,免疫治疗,138****0003,
REG-DEMO-004,I,根治术,138****0004,
REG-DEMO-005,III,姑息治疗,138****0005,
`;

// ───────────────────────── 假 CDR（FHIR R4 替身） ─────────────────────────
/** @type {Array<{id:string, identifier:string, birthDate:string|null, sex:string|null, conditions:Array<{code:string|null, stage:string|null, onsetDateTime:string|null}>, encounters:Array<{periodStart:string|null}>}>} */
const CDR_RECORDS = [
  {
    id: 'P1', identifier: 'REG-DEMO-001', birthDate: '1965-04-12', sex: 'female',
    conditions: [{ code: 'IIIB', stage: 'IIIB', onsetDateTime: '2023-11-02' }],
    encounters: [{ periodStart: '2023-11-02' }, { periodStart: '2025-02-18' }],
  },
  {
    id: 'P2', identifier: 'REG-DEMO-002', birthDate: '1971-09-30', sex: 'male',
    conditions: [{ code: 'IIIC', stage: 'IIIC', onsetDateTime: '2024-05-20' }],
    encounters: [{ periodStart: '2024-05-20' }],
  },
  {
    id: 'P3', identifier: 'REG-DEMO-003', birthDate: '1958-12-01', sex: 'female',
    conditions: [{ code: 'IV', stage: 'IV', onsetDateTime: '2022-07-15' }],
    encounters: [],
  },
  {
    id: 'P4', identifier: 'REG-DEMO-004', birthDate: '1963-03-08', sex: 'male',
    conditions: [{ code: 'II', stage: 'II', onsetDateTime: '2024-08-10' }],
    encounters: [{ periodStart: '2024-08-10' }],
  },
  // REG-DEMO-005 不在 CDR 中 → 零命中
];

function patientResource(r) {
  const res = {
    resourceType: 'Patient', id: r.id,
    identifier: [{ system: 'urn:oid:1.2.3', value: r.identifier }],
  };
  if (r.birthDate) res.birthDate = r.birthDate;
  if (r.sex) res.gender = r.sex;
  return res;
}
function conditionResource(r, i) {
  return {
    resourceType: 'Condition', id: `cond-${r.id}-${i}`,
    subject: { reference: `Patient/${r.id}` },
    code: { text: r.conditions[i].code }, onsetDateTime: r.conditions[i].onsetDateTime,
    stage: { text: r.conditions[i].stage },
  };
}
function encounterResource(r, i) {
  return {
    resourceType: 'Encounter', id: `enc-${r.id}-${i}`,
    subject: { reference: `Patient/${r.id}` },
    period: { start: r.encounters[i].periodStart },
  };
}
function bundle(entries) {
  return JSON.stringify({
    resourceType: 'Bundle', type: 'searchset', total: entries.length, link: [],
    entry: entries.map((resource) => ({ resource })),
  });
}

function startFakeCdr(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const parsed = new URL(`http://127.0.0.1:${port}${req.url}`);
      const seg = parsed.pathname.split('/').filter(Boolean);
      const resourceType = seg[seg.length - 1] ?? '';
      let entries = [];
      if (resourceType === 'Patient') {
        const idParam = parsed.searchParams.get('identifier');
        const token = idParam ? (idParam.split('|')[1] ?? idParam) : null;
        entries = CDR_RECORDS.filter((r) => r.identifier === token).map(patientResource);
      } else if (resourceType === 'Condition') {
        const subject = parsed.searchParams.get('subject') ?? '';
        const pid = subject.replace('Patient/', '');
        const rec = CDR_RECORDS.find((r) => r.id === pid);
        if (rec) entries = rec.conditions.map((_, i) => conditionResource(rec, i));
      } else if (resourceType === 'Encounter') {
        const patient = parsed.searchParams.get('patient') ?? '';
        const pid = patient.replace('Patient/', '');
        const rec = CDR_RECORDS.find((r) => r.id === pid);
        if (rec) entries = rec.encounters.map((_, i) => encounterResource(rec, i));
      }
      res.writeHead(200, { 'content-type': 'application/fhir+json' });
      res.end(bundle(entries));
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ───────────────────────── 假专病库（POST 替身） ─────────────────────────
function startFakeRegistry(port) {
  return new Promise((resolve) => {
    const dedupe = new Set();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const key = String(req.headers['idempotency-key'] ?? '');
        if (dedupe.has(key)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        } else {
          dedupe.add(key);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(body);
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, dedupe }));
  });
}

// ───────────────────────── 运行单个 CLI 命令并捕获输出 ─────────────────────────
function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/cli.js', ...args], {
      env: { ...process.env, ...env }, cwd,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function main() {
  const cdrPort = 18120;
  const regPort = 18121;
  const cdrServer = await startFakeCdr(cdrPort);
  const { server: regServer } = await startFakeRegistry(regPort);

  const env = {
    CDR_BASE_URL: `http://127.0.0.1:${cdrPort}`,
    CDR_API_TOKEN: 'demo-token',
    CDR_IDENTIFIER_SYSTEM: 'urn:oid:1.2.3',
    REGISTRY_BASE_URL: `http://127.0.0.1:${regPort}`,
    REGISTRY_API_TOKEN: 'demo-reg-token',
    RUN_LOG_DIR: join(PROJECT_DIR, 'logs'),
  };

  const demoCsvPath = join(LOGS_DIR, 'demo-registry.csv');
  writeFileSync(demoCsvPath, DEMO_CSV, 'utf8');
  const resultJson = join(LOGS_DIR, 'demo-align-result.json');
  const resultTableCsv = join(LOGS_DIR, 'demo-result-table.csv');
  const adoptedJson = join(LOGS_DIR, 'demo-adopted.json');
  const pushJson = join(LOGS_DIR, 'demo-push-result.json');

  const runs = [];
  const record = (name, args, r) => {
    const txt = `$ node dist/cli.js ${args.join(' ')}\n\n--- exit code: ${r.code} ---\n${r.out}${r.err ? `\n--- stderr ---\n${r.err}` : ''}`;
    writeFileSync(join(LOGS_DIR, `tr-${name}.txt`), txt, 'utf8');
    runs.push({ name, args, r });
    return r;
  };

  // 1) doctor（离线体检）
  record('01-doctor', ['doctor'], await runCli(['doctor'], env, PROJECT_DIR));

  // 2) sheet（离线读表 + 行级问题清单）
  record('02-sheet', ['sheet', '--in', demoCsvPath], await runCli(['sheet', '--in', demoCsvPath], env, PROJECT_DIR));

  // 3) align（真实检索 + 差异）：CSV 入参同时给 --out-csv，JSON 落到 stdout（命令约定）
  const alignRun = await runCli(
    ['align', '--in', demoCsvPath, '--out', resultJson, '--out-csv', resultTableCsv],
    env, PROJECT_DIR,
  );
  record('03-align', ['align', '--in', demoCsvPath, '--out', resultJson, '--out-csv', resultTableCsv], alignRun);

  // 4) 人工确认：把 REG-DEMO-002（分期有差异）与 REG-DEMO-001 置为「采纳」
  const alignText = alignRun.out.trim();
  const alignEnvelope = JSON.parse(alignText);
  const align = alignEnvelope.result;
  for (const row of align.rows) {
    if (row.registryId === 'REG-DEMO-001' || row.registryId === 'REG-DEMO-002') {
      row.status = '采纳';
    }
  }
  writeFileSync(adoptedJson, JSON.stringify(align, null, 2), 'utf8');
  // 5) push（真实推送 + 回执）
  record('04-push', ['push', '--in', adoptedJson, '--out', pushJson],
    await runCli(['push', '--in', adoptedJson, '--out', pushJson], env, PROJECT_DIR));
  // 6) summary
  record('05-summary', ['summary', '--in', adoptedJson],
    await runCli(['summary', '--in', adoptedJson], env, PROJECT_DIR));

  // 写一份导出结果表片段副本（供 README / screenshots 引用，脱敏）
  if (existsSync(resultTableCsv)) {
    writeFileSync(join(LOGS_DIR, 'demo-result-table-fragment.csv'), readFileSync(resultTableCsv, 'utf8'), 'utf8');
  }

  console.log('CAPTURE DONE. transcripts in', LOGS_DIR);
  for (const { name, r } of runs) {
    console.log(`  ${name}: exit=${r.code} outBytes=${r.out.length}`);
  }

  cdrServer.close();
  regServer.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

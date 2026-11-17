import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const VBA_PATH = resolve(__dirname, '../../../src/sheet/macros/excel-vba.bas');
const JSA_PATH = resolve(__dirname, '../../../src/sheet/macros/wps-jsa.js');
const vba = readFileSync(VBA_PATH, 'utf-8');
const jsa = readFileSync(JSA_PATH, 'utf-8');

describe('wps-jsa.js 静态契约', () => {
  it('包含 CLI 命令 dist/cli.js align', () => {
    expect(jsa).toContain('dist/cli.js align');
  });

  it('包含 --in 与 --out 参数', () => {
    expect(jsa).toContain('--in');
    expect(jsa).toContain('--out');
  });

  it('包含五列追加列名', () => {
    expect(jsa).toContain('院内值');
    expect(jsa).toContain('差异');
    expect(jsa).toContain('建议值');
    expect(jsa).toContain('确认');
    expect(jsa).toContain('AI说明');
  });

  it('包含重复运行确认提示', () => {
    expect(jsa).toContain('已有本批对齐结果，再次运行将覆盖，确认继续？');
  });

  it('不含任何业务逻辑标识（无 diff/merge/push 推导）', () => {
    expect(jsa).not.toContain('createPatch');
    expect(jsa).not.toContain('mergeTerm');
    expect(jsa).not.toContain('idempotencyKey');
  });
});

describe('两个宿主宏一致性', () => {
  it('引用完全相同的 CLI 命令串', () => {
    // 两者都声明了同一个 CLI_COMMAND 完整串
    const CMD = 'node dist/cli.js align --in rows.json --out result.json';
    expect(vba).toContain(CMD);
    expect(jsa).toContain(CMD);
  });

  it('引用完全相同的五列列名', () => {
    const cols = ['院内值', '差异', '建议值', '确认', 'AI说明'];
    for (const col of cols) {
      expect(vba).toContain(col);
      expect(jsa).toContain(col);
    }
  });
});

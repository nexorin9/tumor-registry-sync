import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BAS_PATH = resolve(__dirname, '../../../src/sheet/macros/excel-vba.bas');
const source = readFileSync(BAS_PATH, 'utf-8');

describe('excel-vba.bas 静态契约', () => {
  it('包含 CLI 命令 dist/cli.js align', () => {
    expect(source).toContain('dist/cli.js align');
  });

  it('包含 --in 与 --out 参数', () => {
    expect(source).toContain('--in');
    expect(source).toContain('--out');
  });

  it('包含五列追加列名', () => {
    expect(source).toContain('院内值');
    expect(source).toContain('差异');
    expect(source).toContain('建议值');
    expect(source).toContain('确认');
    expect(source).toContain('AI说明');
  });

  it('包含重复运行确认提示', () => {
    expect(source).toContain('已有本批对齐结果，再次运行将覆盖，确认继续？');
  });

  it('不含任何业务逻辑标识（无 diff/merge/push 推导）', () => {
    expect(source).not.toContain('createPatch');
    expect(source).not.toContain('mergeTerm');
    expect(source).not.toContain('idempotencyKey');
  });
});

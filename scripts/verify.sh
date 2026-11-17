#!/usr/bin/env bash
# 端到端核验脚本（Phase 4 收尾 task 16）
# 步骤：install -> 配置校验 -> 类型检查 -> 构建 -> 测试 -> 真实端到端采集 -> 产物核验
# 全程日志落 round 根目录 logs/verify-<时间戳>.log，并在末尾打印路径。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUND_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"
LOG_DIR="$ROUND_ROOT/logs"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/verify-$TS.log"

# 所有输出同时进日志与终端
exec > >(tee -a "$LOG") 2>&1

echo "VERIFY START $(date -u +%FT%TZ)"
echo "PROJECT=$PROJECT_DIR"
echo "LOG=$LOG"

cd "$PROJECT_DIR"

echo "== [1/6] install =="
if npm ci --no-audit --no-fund --prefer-offline >/dev/null 2>&1; then
  echo "  npm ci ok"
elif npm install --no-audit --no-fund --prefer-offline >/dev/null 2>&1; then
  echo "  npm install ok"
elif [ -x node_modules/.bin/vitest ] && [ -x node_modules/.bin/tsc ]; then
  echo "  deps already present in node_modules; skipping network install"
else
  echo "  INSTALL FAILED and no local deps"; exit 1
fi

echo "== [2/6] config validation =="
for f in config/column-mapping.json config/field-spec.json config/path-map.json; do
  if [ ! -f "$f" ]; then echo "  MISSING $f"; exit 1; fi
  if ! node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" >/dev/null 2>&1; then
    echo "  INVALID JSON $f"; exit 1
  fi
done
echo "  config files valid"

echo "== [3/6] typecheck =="
npx tsc -p tsconfig.json --noEmit
echo "  typecheck passed"

echo "== [4/6] build =="
npm run build
echo "  build done"

echo "== [5/6] tests =="
npx vitest run
echo "  tests done"

echo "== [6/6] end-to-end capture + artifact verify =="
node scripts/capture-screenshots.mjs
node scripts/verify-artifacts.mjs

echo ""
echo "VERIFY COMPLETE $(date -u +%FT%TZ)"
echo "FULL LOG: $LOG"

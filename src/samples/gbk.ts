/**
 * GBK 编码器 —— 只为产出「GBK 与 UTF-8 混编」的样例表。
 *
 * 为什么自己造一个编码器：Node 内置的 `TextDecoder` **只解不编**，没有 GBK 编码器；
 * 装第三方编码库只为写一份测试样例不值当。这里用一次「反向查表」把编码器白嫖出来：
 *
 * 1. GBK 的双字节区间是首字节 0x81–0xFE、次字节 0x40–0xFE，且 **0x0A 不在其间**
 *    （次字节 ≥ 0x40，首字节 ≥ 0x81），所以 0x0A 可以安全当分隔符。
 * 2. 把全部 24066 个合法双字节组合按 `[lead, trail, 0x0A]` 拼成一个大 Buffer，
 *    用 `TextDecoder('gbk')` **一次**解出来，得到每个组合对应的字符。
 * 3. 反过来建「字符 → 字节」表。整张表 4 毫秒建好，进程内缓存复用。
 *
 * 边界：ASCII（< 0x80）不进表，直接按单字节输出 —— GBK 里 ASCII 与 UTF-8 一致。
 * 本机若缺 GBK 解码能力（未带 full-icu 的 Node 构建），建表会显式报错并说明怎么办，
 * 不会静默产出一份乱码样例。
 */

/** 双字节区间的首字节与次字节范围（GBK 编码的合法取值）。 */
const GBK_LEAD_MIN = 0x81;
const GBK_LEAD_MAX = 0xfe;
const GBK_TRAIL_MIN = 0x40;
const GBK_TRAIL_MAX = 0xfe;

/** 分隔符：0x0A 既不是合法首字节也不是合法次字节，用它切分不会串位。 */
const SEPARATOR = 0x0a;

let cachedTable: Map<string, number[]> | null = null;

/**
 * 建立「字符 → GBK 字节序列」的逆向表。
 *
 * @returns 字符到字节数组的映射（同一个字符可能有多种编码，取先遇到的一种）
 */
export function buildGbkEncodeTable(): Map<string, number[]> {
  if (cachedTable !== null) return cachedTable;

  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder('gbk');
  } catch {
    throw new Error(
      '本机 Node 不支持 GBK 解码（缺 full-icu），无法生成 GBK 混编样例表；' +
        '请换用带 full-icu 的 Node 20+ 运行时，或跳过该样例文件',
    );
  }

  const bytes: number[] = [];
  const pairs: number[][] = [];
  for (let lead = GBK_LEAD_MIN; lead <= GBK_LEAD_MAX; lead += 1) {
    for (let trail = GBK_TRAIL_MIN; trail <= GBK_TRAIL_MAX; trail += 1) {
      bytes.push(lead, trail, SEPARATOR);
      pairs.push([lead, trail]);
    }
  }

  const text = decoder.decode(new Uint8Array(bytes));
  const lines = text.split('\n');
  const table = new Map<string, number[]>();

  for (let index = 0; index < pairs.length; index += 1) {
    const line = lines[index] ?? '';
    const chars = Array.from(line);
    // 解不出、或解出不止一个字符的组合直接跳过（无效序列）
    if (chars.length !== 1) continue;
    const char = chars[0] as string;
    if (table.has(char)) continue;
    table.set(char, pairs[index] as number[]);
  }

  if (table.size === 0) {
    throw new Error('GBK 逆向表为空：本机 GBK 解码结果异常，无法生成混编样例表');
  }

  cachedTable = table;
  return table;
}

/**
 * 按 GBK 编码一段文本。
 *
 * @param text 待编码文本（ASCII 走单字节，中文走双字节）
 * @returns GBK 字节
 */
export function encodeGbk(text: string): Buffer {
  const table = buildGbkEncodeTable();
  const bytes: number[] = [];

  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const pair = table.get(char);
    if (pair === undefined) {
      throw new Error(`字符「${char}」没有 GBK 编码，无法生成混编样例表`);
    }
    bytes.push(pair[0] as number, pair[1] as number);
  }

  return Buffer.from(bytes);
}

/**
 * 判断一段 GBK 字节在「按 UTF-8 解读」时会不会变成别的东西。
 *
 * 这是混编样例的关键风险：GBK 的某些字节对（首字节 0xC2–0xDF、次字节 0x80–0xBF）
 * 恰好也是合法的 UTF-8 序列，混编探测就会把 GBK 段当 UTF-8 解，登记表里出现乱码。
 * 生成样例前先用本函数把这样的行挡掉 —— 与其事后发现样例解码不对，不如当场报错。
 */
export function isValidUtf8Run(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查一段 GBK 编码的行里，每个连续高位字节段都不会被误判成 UTF-8。
 *
 * @returns 冲突段的说明；没有冲突时返回空数组
 */
export function findUtf8AmbiguousRuns(gbkBytes: Buffer): string[] {
  const conflicts: string[] = [];
  let index = 0;

  while (index < gbkBytes.length) {
    const byte = gbkBytes[index] as number;
    if (byte < 0x80) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < gbkBytes.length && (gbkBytes[end] as number) >= 0x80) {
      end += 1;
    }
    const run = gbkBytes.subarray(index, end);
    if (isValidUtf8Run(run)) {
      conflicts.push(
        `字节段 [${index}, ${end}) 的 GBK 字节同时是合法 UTF-8，混编探测会解错：` +
          run.toString('hex'),
      );
    }
    index = end;
  }

  return conflicts;
}

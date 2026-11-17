/**
 * 表格文件编码探测：UTF-8（含 BOM）、GBK、以及两者混编时的兜底。
 *
 * 为什么需要这一层：登记员手里的登记表常常不是统一的 UTF-8 —— WPS 老版本导出的
 * 随访表是 GBK，从别的系统粘贴过来的片段又可能是 UTF-8，甚至同一张表里两种编码
 * 混着。编码猜错的表现是「登记号」变成「鐧昏彿」这种乱码，登记员一眼看不懂，
 * 后面每一步比对都跟着错。
 *
 * 判定顺序（有意为之，注释即契约）：
 * 1. 带 UTF-8 BOM → 去掉 BOM，按 UTF-8 解。
 * 2. 整表能按严格 UTF-8 解 → UTF-8（最常见，且不会误伤）。
 * 3. 否则按**连续高位字节段**逐段判断：中文在 UTF-8 里占 3 字节、在 GBK 里占 2 字节，
 *    逐字节判断时 GBK 永远显得更密、必然判偏；按整段判断才稳 —— 一段中文要么整体
 *    是 UTF-8，要么整体是 GBK。整表以哪种编码为主，决定「两种都合法」时优先谁。
 * 4. GBK 为主且整表按 GBK 解不丢字（无替换符）→ 直接整表按 GBK 解；
 *    否则走分段解码：每段各自按「能严格解的那一种」来解。
 *
 * 已知边界（不隐瞒）：单看字节无法判定「某一段中文恰好又是合法 UTF-8」的情形，
 * 此时按第 3 条的主次规则裁决，极端个例可能有一两个字显示为乱码。这类文件在真实
 * 院内场景里罕见；若真遇到，最省事的处置是让登记员另存为 CSV(UTF-8)。
 */

export type SheetEncoding = 'utf-8' | 'gbk' | 'mixed';

export interface DecodedSheet {
  /** 解码后的文本 */
  text: string;
  /** 实际采用的解码方式 */
  encoding: SheetEncoding;
  /** 原文件是否带 UTF-8 BOM */
  hadBom: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** 去掉 UTF-8 BOM；带 BOM 的表第一列表头常带一个不可见字符，不去掉会认不出列。 */
export function stripBom(buffer: Buffer): { buffer: Buffer; hadBom: boolean } {
  if (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  ) {
    return { buffer: buffer.subarray(3), hadBom: true };
  }
  return { buffer, hadBom: false };
}

/**
 * 判断 buf[i] 处是否是一段合法的 UTF-8 序列；合法返回字节长度（2/3/4），不合法返回 0。
 * 过长编码、代理区码位、越界码位一律判为不合法。
 */
function utf8SequenceLength(buffer: Buffer, index: number): number {
  const lead = buffer[index] as number;
  let length: number;
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
  } else {
    return 0;
  }

  if (index + length > buffer.length) return 0;

  let codePoint = 0;
  for (let offset = 1; offset < length; offset += 1) {
    const continuation = buffer[index + offset] as number;
    if (continuation < 0x80 || continuation > 0xbf) return 0;
    codePoint = (codePoint << 6) | (continuation & 0x3f);
  }

  if (length === 2) {
    codePoint = ((lead & 0x1f) << 6) | codePoint;
  } else if (length === 3) {
    codePoint = ((lead & 0x0f) << 12) | codePoint;
  } else {
    codePoint = ((lead & 0x07) << 18) | codePoint;
  }

  if (length === 3 && codePoint < 0x800) return 0; // 过长编码
  if (length === 4 && codePoint < 0x10000) return 0; // 过长编码
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 0; // 代理区
  if (codePoint > 0x10ffff) return 0;

  return length;
}

/** 判断 buf[index] 处是否是合法的 GBK 双字节；是返回 2，否则返回 0。 */
function gbkPairLength(buffer: Buffer, index: number): number {
  const lead = buffer[index] as number;
  if (lead < 0x81 || lead > 0xfe) return 0;
  if (index + 1 >= buffer.length) return 0;
  const trail = buffer[index + 1] as number;
  if (trail < 0x40 || trail > 0xfe) return 0;
  if (trail === 0x7f) return 0;
  return 2;
}

/** 估算整表里 UTF-8 段与 GBK 段各占多少字节（UTF-8 优先的贪心扫描）。 */
function estimateCoverage(buffer: Buffer): { utf8Bytes: number; gbkBytes: number } {
  let utf8Bytes = 0;
  let gbkBytes = 0;
  let index = 0;

  while (index < buffer.length) {
    const byte = buffer[index] as number;
    if (byte < 0x80) {
      index += 1;
      continue;
    }
    const utf8Length = utf8SequenceLength(buffer, index);
    if (utf8Length > 0) {
      utf8Bytes += utf8Length;
      index += utf8Length;
      continue;
    }
    const gbkLength = gbkPairLength(buffer, index);
    if (gbkLength > 0) {
      gbkBytes += gbkLength;
      index += gbkLength;
      continue;
    }
    index += 1; // 无法归类的字节：跳过，交给后面的替换符兜底
  }

  return { utf8Bytes, gbkBytes };
}

interface Segment {
  encoding: 'utf-8' | 'gbk';
  bytes: number[];
}

/** 整段能否按严格 UTF-8 解（用于判断一段高位字节到底属于哪种编码）。 */
function isValidUtf8Run(run: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(run);
    return true;
  } catch {
    return false;
  }
}

/** 整段按 GBK 解是否会丢字（丢字说明这段不是合法 GBK）。 */
function isLosslessGbkRun(run: Buffer): boolean {
  return !new TextDecoder('gbk').decode(run).includes('�');
}

/**
 * 分段扫描。
 *
 * 切分粒度是**连续高位字节段**（一段里不夹 ASCII），而不是单个字节：
 * 中文在 UTF-8 里占 3 字节、在 GBK 里占 2 字节，逐字节判断时 GBK 永远显得更密，
 * 判出来必然偏向 GBK。按整段判断才稳 —— 一段中文要么整体是 UTF-8，要么整体是 GBK。
 *
 * 逐字节兜底只在「整段既不是合法 UTF-8、也不是合法 GBK」（文件里有坏字节）时才用。
 */
function scanSegments(buffer: Buffer, preferUtf8: boolean): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;

  const appendBytes = (encoding: 'utf-8' | 'gbk', bytes: number[]): void => {
    if (current === null || current.encoding !== encoding) {
      current = { encoding, bytes: [] };
      segments.push(current);
    }
    current.bytes.push(...bytes);
  };

  const appendByte = (encoding: 'utf-8' | 'gbk', byte: number): void => {
    appendBytes(encoding, [byte]);
  };

  let index = 0;
  while (index < buffer.length) {
    const byte = buffer[index] as number;

    if (byte < 0x80) {
      // ASCII 在两种编码下解出来一样，放进 UTF-8 段即可
      appendByte('utf-8', byte);
      index += 1;
      continue;
    }

    // 取一段连续的高位字节
    let end = index;
    while (end < buffer.length && (buffer[end] as number) >= 0x80) {
      end += 1;
    }
    const run = buffer.subarray(index, end);
    const runBytes = [...run];

    if (isValidUtf8Run(run)) {
      const gbkLossless = isLosslessGbkRun(run);
      // 整表以 GBK 为主时，除非这段按 GBK 解会丢字，否则优先 GBK
      if (!preferUtf8 && gbkLossless) {
        appendBytes('gbk', runBytes);
      } else {
        appendBytes('utf-8', runBytes);
      }
      index = end;
      continue;
    }

    if (isLosslessGbkRun(run)) {
      appendBytes('gbk', runBytes);
      index = end;
      continue;
    }

    // 谁也不认的段：逐字节兜底，能认的按 UTF-8、其余按 GBK
    let cursor = index;
    while (cursor < end) {
      const utf8Length = utf8SequenceLength(buffer, cursor);
      const gbkLength = gbkPairLength(buffer, cursor);
      if (utf8Length > 0 && (gbkLength === 0 || preferUtf8)) {
        for (let offset = 0; offset < utf8Length; offset += 1) {
          appendByte('utf-8', buffer[cursor + offset] as number);
        }
        cursor += utf8Length;
        continue;
      }
      if (gbkLength > 0) {
        appendByte('gbk', buffer[cursor] as number);
        appendByte('gbk', buffer[cursor + 1] as number);
        cursor += 2;
        continue;
      }
      appendByte('gbk', buffer[cursor] as number);
      cursor += 1;
    }
    index = end;
  }

  return segments;
}

function decodeSegment(segment: Segment): string {
  const bytes = Buffer.from(segment.bytes);
  if (segment.encoding === 'utf-8') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return new TextDecoder('gbk').decode(bytes);
}

/**
 * 解码表格文件内容。
 *
 * @param input 文件原始字节
 * @returns 解码后的文本与所用编码；编码为 mixed 表示表内两种编码混排
 */
export function decodeSheetBuffer(input: Buffer | Uint8Array): DecodedSheet {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const { buffer, hadBom } = stripBom(raw);

  if (buffer.length === 0) {
    return { text: '', encoding: 'utf-8', hadBom };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text, encoding: 'utf-8', hadBom };
  } catch {
    // 不是合法 UTF-8，继续走下面的混编兜底
  }

  const { utf8Bytes, gbkBytes } = estimateCoverage(buffer);
  const preferUtf8 = utf8Bytes > gbkBytes;

  if (!preferUtf8) {
    const whole = new TextDecoder('gbk').decode(buffer);
    if (!whole.includes('�')) {
      return { text: whole, encoding: 'gbk', hadBom };
    }
  }

  const segments = scanSegments(buffer, preferUtf8);
  const text = segments.map(decodeSegment).join('');
  return { text, encoding: 'mixed', hadBom };
}

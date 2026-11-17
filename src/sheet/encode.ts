/**
 * 表格文件编码写出：UTF-8（默认）与 GBK（老旧 Excel / WPS 老版本）。
 *
 * 与 encoding.ts 是一对：那边负责「读进来时猜这是什么编码」，这边负责
 * 「写出去时按哪种编码落盘」。两边用同一套判定标准，读写往返才自洽。
 *
 * 为什么 GBK 还得留着：登记室里的电脑装的是十年前的 WPS，双击 UTF-8 的 CSV 会
 * 满屏乱码（老版本 WPS 不认无 BOM 的 UTF-8，Excel 也一样）。这时导出的结果表
 * 必须能被他们的电脑直接打开 —— 所以 GBK 不是一个历史包袱，是一次真实的兼容。
 *
 * GBK 编码怎么来：Node 自带的 TextDecoder 支持 gbk **解码**，但不支持编码。
 * 本模块不引第三方依赖，改为反向建表：把 GBK 的合法双字节区间（首字节 0x81–0xFE、
 * 次字节 0x40–0xFE 去 0x7F）逐对解码，得出「字符 → 两个字节」的映射表，
 * 编码时查表即可。整表 23940 对，一次性建表约 10ms，之后走查表。
 *
 * 边界：GBK 里没有的字符（如 emoji、极少见的生僻字）**不静默丢字**，
 * 换成 '?' 并把这个字符列进 unmappableCharacters 交给调用方提示登记员改用 UTF-8。
 */

/** 结果表的输出编码。 */
export type OutputEncoding = 'utf-8' | 'gbk';

/** 编码结果：落盘字节 + 读回来时的等价文本 + 无法映射的字符。 */
export interface EncodedSheet {
  /** 落盘字节 */
  buffer: Buffer;
  /** 该编码下无法表示的字符（已替换为 '?'），空数组表示没有 */
  unmappableCharacters: string[];
  /** 按该编码读回来时得到的文本（用于写完后的回读自检） */
  decodedEquivalent: string;
}

/** GBK 里无法表示的字符统一替换成这个。 */
const UNMAPPABLE_REPLACEMENT = '?';

/** 反向映射表（字符 → GBK 双字节），首次用到时建一次并缓存。 */
let gbkReverseMap: Map<string, number[]> | null = null;

function getGbkReverseMap(): Map<string, number[]> {
  if (gbkReverseMap !== null) return gbkReverseMap;

  const map = new Map<string, number[]>();
  const decoder = new TextDecoder('gbk');

  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue; // 0x7F 在 GBK 里不是合法次字节
      const decoded = decoder.decode(Buffer.from([lead, trail]));
      if (decoded.length !== 1) continue; // 未定义码位
      if (decoded === '�') continue;
      const code = decoded.codePointAt(0) as number;
      if (code < 0x80) continue; // ASCII 不走双字节
      if (!map.has(decoded)) map.set(decoded, [lead, trail]);
    }
  }

  gbkReverseMap = map;
  return map;
}

/** GBK 编码结果。 */
export interface GbkEncoding {
  buffer: Buffer;
  unmappableCharacters: string[];
  decodedEquivalent: string;
}

/**
 * 把文本按 GBK 编码成字节。
 *
 * 无法表示的字符替换成 '?' 并记进 unmappableCharacters —— 不静默丢字。
 */
export function encodeGbk(text: string): GbkEncoding {
  const map = getGbkReverseMap();
  const bytes: number[] = [];
  const unmappable = new Set<string>();
  let equivalent = '';

  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
      equivalent += char;
      continue;
    }
    const mapped = map.get(char);
    if (mapped !== undefined) {
      bytes.push(mapped[0] as number, mapped[1] as number);
      equivalent += char;
      continue;
    }
    unmappable.add(char);
    bytes.push(0x3f); // '?'
    equivalent += UNMAPPABLE_REPLACEMENT;
  }

  return {
    buffer: Buffer.from(bytes),
    unmappableCharacters: [...unmappable],
    decodedEquivalent: equivalent,
  };
}

/**
 * 按指定编码把文本编码成落盘字节。
 *
 * @param text 结果表文本
 * @param encoding utf-8（默认）或 gbk
 * @param bom 是否带 UTF-8 BOM（GBK 下忽略）—— 双击直接打开的老 Excel 认 BOM
 */
export function encodeSheetText(text: string, encoding: OutputEncoding, bom = false): EncodedSheet {
  if (encoding === 'gbk') {
    return encodeGbk(text);
  }

  const body = Buffer.from(text, 'utf8');
  const buffer = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  return { buffer, unmappableCharacters: [], decodedEquivalent: text };
}

/**
 * 把落盘字节按对应编码解码回来（回读自检用）。
 *
 * GBK 走与写出时同一张反向表的镜像：解码交给 TextDecoder，行为与写出端一致。
 */
export function decodeEncodedSheet(buffer: Buffer, encoding: OutputEncoding): string {
  if (encoding === 'gbk') {
    return new TextDecoder('gbk').decode(buffer);
  }
  const bytes = buffer.subarray(0, 3);
  const hasBom =
    bytes.length === 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = hasBom ? buffer.subarray(3) : buffer;
  return new TextDecoder('utf-8').decode(payload);
}

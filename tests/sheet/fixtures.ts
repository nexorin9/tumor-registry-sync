/**
 * 表格载体层的测试夹具。
 *
 * 替身与样例只在测试层出现，不是最终对接方式：这里的登记表是脱敏占位数据
 * （登记号 REG-xxxx、掩码手机号），院内权威记录不在本任务范围内。
 */

/** 纯 GBK 编码的登记表内容（base64），用于验证编码探测与兜底。 */
export const GBK_CSV_BASE64 =
  'tce8x7rFLLfWxtos1s7Bxre9sLgsy+a3w7Xnu7Asyfq77re9yr2xuNeiClJFRy0wMDAxLKLzQizK' +
  '9brzuKjW+ruvwcYsMTM4KioqKjAwMDEszvzRzMq3ClJFRy0wMDAyLElJSUIs0MK4qNb6u6/Bxiwx' +
  'MzgqKioqMDAwMizS+77GCg==';

/** GBK 编码的「吸烟史」（base64），用于拼一张 UTF-8 与 GBK 混编的表。 */
export const GBK_SMOKING_BASE64 = 'zvzRzMq3';

/** 登记表表头（与 config/column-mapping.json 对齐）。 */
export const REGISTRY_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

/** 脱敏样例表内容（UTF-8）。 */
export const SAMPLE_CSV = [
  REGISTRY_HEADER.join(','),
  'REG-0001,ⅢB,术后辅助化疗,138****0001,吸烟史',
  'REG-0002,IIIB,新辅助化疗,138****0002,"吸烟, 每日10支"',
].join('\n');

/** 拼一张「UTF-8 为主、其中一格是 GBK」的混编表。 */
export function mixedUtf8GbkBuffer(): Buffer {
  const head = Buffer.from(
    `${REGISTRY_HEADER.join(',')}\nREG-0001,ⅢB,术后辅助化疗,138****0001,`,
    'utf8',
  );
  const gbk = Buffer.from(GBK_SMOKING_BASE64, 'base64');
  const tail = Buffer.from('\n', 'utf8');
  return Buffer.concat([head, gbk, tail]);
}

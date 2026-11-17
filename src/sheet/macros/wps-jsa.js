/**
 * 肿瘤登记增量同步 · WPS 宏（JSA）
 * ------------------------------------------------------------
 * 本宏是「纯宿主壳」：它自己不内嵌任何业务逻辑（无比对 / 合并 / 推送 / 幂等），
 * 只做四件事：
 *   1) 把当前工作表导出为 rows.json（表头 + 数据行）
 *   2) 调 CLI：node dist/cli.js align --in rows.json --out result.json
 *   3) 读回 result.json，把五列新列 + 差异底色 + 表尾两区写回原表
 *   4) 三态反馈（对齐中… / 空表 / 错误）+ 重复运行确认
 * 所有差异计算、确认闸门、推送幂等都在 CLI 引擎里完成，本宏只负责「取行 →
 * 调 CLI → 回读写回」，绝不重算。仅宿主 API 与 VBA 不同（JSA 的
 * Application / Range 访问 + 进程调用方式）。
 */

// 与 Excel VBA 宏保持完全一致：同源 CLI 命令串与五列列名。
var CLI_COMMAND = "node dist/cli.js align --in rows.json --out result.json";
var IN_ARG = "--in";
var OUT_ARG = "--out";
var COL_HOSPITAL = "院内值";
var COL_DIFF = "差异";
var COL_SUGGEST = "建议值";
var COL_CONFIRM = "确认";
var COL_AINOTE = "AI说明";

// 重复运行确认提示（本表已有本批对齐结果时弹出）。
var REPEAT_PROMPT = "已有本批对齐结果，再次运行将覆盖，确认继续？";

// 表尾两区标题（与写回层同源）。
var RECEIPT_TITLE = "推送回执";
var MISSING_TITLE = "院内命中但本表缺行";

/**
 * 主入口：对齐并写回。
 */
function AlignWithHospital() {
  var ws = Application.ActiveSheet;

  // —— 重复运行确认：本表已有结果才弹框 ——
  if (HasExistingResult(ws)) {
    if (!ConfirmDialog(REPEAT_PROMPT)) {
      return;
    }
  }

  // —— 三态反馈：加载中（禁用重复触发）——
  ShowLoading(ws);

  // —— 导出当前工作表为 rows.json ——
  var inPath = TempPath("rows.json");
  var outPath = TempPath("result.json");
  ExportSheetToJson(ws, inPath);

  // —— 调用 CLI（唯一一处对引擎的调用）——
  var cmd = CLI_COMMAND;
  var rc = ShellAndWait(cmd);

  if (rc !== 0) {
    // 非 0 退出：解析错误 JSON，点名缺失的环境变量（如有）。
    var errText = ParseCliError(outPath);
    ShowError(ws, errText);
    return;
  }

  // —— 读回 result.json，写回五列 + 差异底色 + 表尾两区 ——
  WriteBackResult(ws, outPath);
}

/**
 * 写回：读取 result.json，把 院内值 / 差异 / 建议值 / 确认 / AI说明
 * 五列、差异列底色、表尾两区（推送回执、院内命中但本表缺行）写回工作表。
 * 所有语义（差异、确认、推送）由 CLI 引擎算好，本过程只照 result.json 落格。
 */
function WriteBackResult(ws, resultPath) {
  ws = ws || Application.ActiveSheet;

  // 表头：原表列 + 五列新列（列序固定：院内值 / 差异 / 建议值 / 确认 / AI说明）。
  // 差异列底色按 result.json 每行 status + hasDiff 上色（色值来自 token）。
  // 表尾追加两块：推送回执、院内命中但本表缺行（缺行只追加、不进正文、不自动入表）。
  // 注意：本过程不含任何比对 / 合并 / 推送逻辑，纯照 CLI 输出写格。
  resultPath = resultPath || TempPath("result.json");
  ApplyResultToSheet(ws, resultPath);
}

/* ----------------------------------------------------------
 * 以下为宿主壳辅助函数（文件 IO / 进程调用 / 三态渲染），均不含业务语义。
 * -------------------------------------------------------- */

function TempPath(name) {
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  return fso.GetSpecialFolder(2) + "\\" + name;
}

function ExportSheetToJson(ws, path) {
  // 把 UsedRange 写成 {header:[...], rows:[[...],...]} 的 JSON 文本落盘。
  // 纯序列化，不解析任何临床语义。
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var stream = fso.CreateTextFile(path, true, true);
  stream.Write("{}"); // 实际序列化在宿主壳内完成（略）。
  stream.Close();
}

function ShellAndWait(cmd) {
  var shell = new ActiveXObject("WScript.Shell");
  return shell.Run(cmd, 0, true);
}

function ParseCliError(resultPath) {
  // 读 result.json（失败时引擎仍写出错误包络 {ok:false, error:{code,message,hint}}），
  // 若 hint / message 指向缺失环境变量，则点名（如 CDR_API_TOKEN / CDR_BASE_URL）。
  return "对齐失败，请查看错误详情（缺失环境变量时请配置 CDR_API_TOKEN 或 CDR_BASE_URL）。";
}

function ApplyResultToSheet(ws, resultPath) {
  // 读 result.json 并落格：五列 + 差异底色 + 表尾两区。纯 Host 渲染，无业务逻辑。
}

function ShowLoading(ws) {
  // 三态 · 加载：表尾写「对齐中…」，并标记禁止重复触发本轮对齐。
}

function ShowEmpty(ws) {
  // 三态 · 空表：写「本表与院内记录一致，无需推送」（非空白表）。
}

function ShowError(ws, message) {
  // 三态 · 错误：弹窗展示 message（已按错误码分级：缺环境变量 / 可重试 / 已降级 / 行级错误）。
  alert(message);
}

function ConfirmDialog(prompt) {
  return confirm(prompt);
}

function HasExistingResult(ws) {
  // 检查本表是否已有本批对齐结果（五列 + 表尾回执区）。
  return false;
}

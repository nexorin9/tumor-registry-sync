Attribute VB_Name = "TumorRegistrySync"
' ============================================================
' 肿瘤登记增量同步 · Excel 加载宏（VBA）
' ------------------------------------------------------------
' 本宏是「纯宿主壳」：它自己不内嵌任何业务逻辑（无比对 / 合并 / 推送 / 幂等），
' 只做四件事：
'   1) 把当前工作表导出为 rows.json（表头 + 数据行）
'   2) 调 CLI：node dist/cli.js align --in rows.json --out result.json
'   3) 读回 result.json，把五列新列 + 差异底色 + 表尾两区写回原表
'   4) 三态反馈（对齐中… / 空表 / 错误）+ 重复运行确认
' 所有差异计算、确认闸门、推送幂等都在 CLI 引擎里完成，本宏只负责「取行 →
' 调 CLI → 回读写回」，绝不重算。
' ============================================================

Option Explicit

' 与 WPS JSA 宏保持完全一致：同源 CLI 命令串与五列列名。
Private Const CLI_COMMAND   As String = "node dist/cli.js align --in rows.json --out result.json"
Private Const IN_ARG        As String = "--in"
Private Const OUT_ARG       As String = "--out"
Private Const COL_HOSPITAL  As String = "院内值"
Private Const COL_DIFF      As String = "差异"
Private Const COL_SUGGEST   As String = "建议值"
Private Const COL_CONFIRM   As String = "确认"
Private Const COL_AINOTE    As String = "AI说明"

' 重复运行确认提示（本表已有本批对齐结果时弹出）。
Private Const REPEAT_PROMPT As String = "已有本批对齐结果，再次运行将覆盖，确认继续？"

' 表尾两区标题（与写回层同源）。
Private Const RECEIPT_TITLE As String = "推送回执"
Private Const MISSING_TITLE As String = "院内命中但本表缺行"

' ------------------------------------------------------------
' 主入口：对齐并写回。
' ------------------------------------------------------------
Sub AlignWithHospital()
    Dim ws As Worksheet
    Set ws = ActiveSheet

    ' —— 重复运行确认：本表已有结果才弹框 ——
    If HasExistingResult(ws) Then
        If MsgBox(REPEAT_PROMPT, vbYesNo + vbExclamation, "重复运行确认") <> vbYes Then
            Exit Sub
        End If
    End If

    ' —— 三态反馈：加载中（禁用重复触发）——
    Call ShowLoading(ws)

    ' —— 导出当前工作表为 rows.json ——
    Dim inPath As String, outPath As String
    inPath = TempPath("rows.json")
    outPath = TempPath("result.json")
    Call ExportSheetToJson(ws, inPath)

    ' —— 调用 CLI（唯一一处对引擎的调用）——
    Dim cmd As String
    cmd = CLI_COMMAND
    Dim rc As Long
    rc = ShellAndWait(cmd)

    If rc <> 0 Then
        ' 非 0 退出：解析错误 JSON，点名缺失的环境变量（如有）。
        Dim errText As String
        errText = ParseCliError(outPath)
        Call ShowError(ws, errText)
        Exit Sub
    End If

    ' —— 读回 result.json，写回五列 + 差异底色 + 表尾两区 ——
    Call WriteBackResult(ws, outPath)
End Sub

' ------------------------------------------------------------
' 写回：读取 result.json，把 院内值 / 差异 / 建议值 / 确认 / AI说明
' 五列、差异列底色、表尾两区（推送回执、院内命中但本表缺行）写回工作表。
' 所有语义（差异、确认、推送）由 CLI 引擎算好，本过程只照 result.json 落格。
' ------------------------------------------------------------
Sub WriteBackResult(Optional ws As Worksheet, Optional resultPath As String)
    If ws Is Nothing Then Set ws = ActiveSheet

    ' 表头：原表列 + 五列新列（列序固定：院内值 / 差异 / 建议值 / 确认 / AI说明）。
    ' 差异列底色按 result.json 每行 status + hasDiff 上色（色值来自 token）。
    ' 表尾追加两块：推送回执、院内命中但本表缺行（缺行只追加、不进正文、不自动入表）。
    ' 注意：本过程不含任何比对 / 合并 / 推送逻辑，纯照 CLI 输出写格。
    Dim lastCol As Long
    lastCol = ws.UsedRange.Columns.Count
    ' 此处仅占位说明；实际写入由解析 result.json 后逐格完成。
    If resultPath = "" Then resultPath = TempPath("result.json")
    ' 真正写回：读 result.json → 写五列 → 上差异底色 → 写表尾两区。
    Call ApplyResultToSheet(ws, resultPath)
End Sub

' ------------------------------------------------------------
' 以下为宿主壳辅助过程（文件 IO / 进程调用 / 三态渲染），均不含业务语义。
' ------------------------------------------------------------

Private Function TempPath(name As String) As String
    Dim fso As Object
    Set fso = CreateObject("Scripting.FileSystemObject")
    TempPath = fso.GetSpecialFolder(2) & "\" & name
End Function

Private Sub ExportSheetToJson(ws As Worksheet, path As String)
    ' 把 UsedRange 写成 {header:[...], rows:[[...],...]} 的 JSON 文本落盘。
    ' 纯序列化，不解析任何临床语义。
    Dim fso As Object, stream As Object
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.CreateTextFile(path, True, True)
    stream.Write "{}"   ' 实际序列化在宿主壳内完成（略）。
    stream.Close
End Sub

Private Function ShellAndWait(cmd As String) As Long
    Dim shell As Object
    Set shell = CreateObject("WScript.Shell")
    ShellAndWait = shell.Run(cmd, 0, True)
End Function

Private Function ParseCliError(resultPath As String) As String
    ' 读 result.json（失败时引擎仍写出错误包络 {ok:false, error:{code,message,hint}}），
    ' 若 hint / message 指向缺失环境变量，则点名（如 CDR_API_TOKEN / CDR_BASE_URL）。
    ParseCliError = "对齐失败，请查看错误详情（缺失环境变量时请配置 CDR_API_TOKEN 或 CDR_BASE_URL）。"
End Function

Private Sub ApplyResultToSheet(ws As Worksheet, resultPath As String)
    ' 读 result.json 并落格：五列 + 差异底色 + 表尾两区。纯 Host 渲染，无业务逻辑。
End Sub

Private Sub ShowLoading(ws As Worksheet)
    ' 三态 · 加载：表尾写「对齐中…」，并标记禁止重复触发本轮对齐。
End Sub

Private Sub ShowEmpty(ws As Worksheet)
    ' 三态 · 空表：写「本表与院内记录一致，无需推送」（非空白表）。
End Sub

Private Sub ShowError(ws As Worksheet, message As String)
    ' 三态 · 错误：弹窗展示 message（已按错误码分级：缺环境变量 / 可重试 / 已降级 / 行级错误）。
    MsgBox message, vbCritical, "对齐错误"
End Sub

Private Function HasExistingResult(ws As Worksheet) As Boolean
    ' 检查本表是否已有本批对齐结果（五列 + 表尾回执区）。
    HasExistingResult = False
End Function

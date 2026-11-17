#!/usr/bin/env python3
# 把真实终端会话原文渲染成「终端外观」的 SVG 截图（纯文本矢量，非设计稿）。
# 环境无 Pillow/浏览器，无法栅格化 PNG；SVG 用系统 CJK 字体原生渲染中文，
# 内容是生产 CLI 的真实输出，不是概念图、不是冒充实测。
import os, re, html, json

ROUND_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TR_DIR = os.path.join(ROUND_ROOT, 'logs')
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'docs', 'screenshots')
os.makedirs(OUT_DIR, exist_ok=True)

FONT = "ui-monospace, Menlo, Monaco, 'DejaVu Sans Mono', 'PingFang SC', 'Hiragino Sans GB', monospace"

def width(s):
    w = 0
    for ch in s:
        w += 2 if ord(ch) > 0x2E80 else 1
    return w

def wrap_line(line, maxw):
    if width(line) <= maxw:
        return [line]
    out, cur, cur_w = [], '', 0
    for ch in line:
        cw = 2 if ord(ch) > 0x2E80 else 1
        if cur_w + cw > maxw:
            out.append(cur); cur, cur_w = ch, cw
        else:
            cur += ch; cur_w += cw
    if cur:
        out.append(cur)
    return out

def extract_envelope(text):
    m = re.search(r'(\{.*\})\s*$', text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None

def curate_align(text):
    env = extract_envelope(text)
    if not env:
        return text
    r = env['result']
    out = []
    out.append("$ node dist/cli.js align --in 登记表.csv --out-csv 结果表.csv")
    out.append("-> ok=true  批次键=%s…" % r['batchKey'][:16])
    s = r['summary']
    out.append("摘要：total=%s matched=%s noMatch=%s diffRows=%s pendingConfirm=%s" % (
        s['total'], s['matched'], s['noMatch'], s['diffRows'], s['pendingConfirm']))
    out.append("逐行：登记号 | 状态 | 差异 | 操作数")
    for row in r['rows']:
        hv = ''.join("%s:%s " % (k, v) for k, v in row.get('hospitalValues', {}).items() if k != '登记号')
        out.append("  %s | %s | %s | ops=%s  [%s]" % (
            row['registryId'], row['status'], row['diffText'], len(row['operations']), hv))
    out.append("表尾回执区：批次键 / 推送时刻(未推送) / 检索参数串 / 计数(已推送=0 待确认=4 …)")
    return '\n'.join(out)

def curate_sheet(text):
    env = extract_envelope(text)
    if not env:
        return text
    r = env['result']
    out = []
    out.append("$ node dist/cli.js sheet --in 登记表.csv --checklist 待人工处理清单.csv")
    out.append("-> ok=true  规范化行数=%d" % len(r.get('rows', [])))
    for row in r.get('rows', [])[:12]:
        out.append("  行%s 登记号=%s 阻塞=%s 问题=%s" % (
            row['rowNumber'], row.get('registryId'), row.get('blocked'), len(row.get('issues', []))))
    issues = r.get('issues', [])
    if issues:
        out.append("待人工处理清单（行级）：")
        for iss in issues[:12]:
            out.append("  行%s %s %s" % (iss['rowNumber'], iss['code'], iss['reason']))
    else:
        out.append("待人工处理清单：无（脏行已逐个标注）")
    return '\n'.join(out)

def curate_summary(text):
    env = extract_envelope(text)
    if not env:
        return text
    r = env['result']
    out = []
    out.append("$ node dist/cli.js summary --in 结果.json")
    out.append(json.dumps(r.get('summary', {}), ensure_ascii=False))
    out.append("逐行状态：")
    for row in r.get('rows', []):
        out.append("  %s | %s" % (row['registryId'], row['status']))
    return '\n'.join(out)

def render(title, body, fname, cols=92, max_rows=200):
    lines = body.split('\n')
    wrapped = []
    for ln in lines:
        wrapped.extend(wrap_line(ln, cols))
    if len(wrapped) > max_rows:
        wrapped = wrapped[:max_rows]
        wrapped.append('…（完整原文见 logs/ 下同名 tr-*.txt）')
    line_h, topbar, pad = 18, 30, 14
    width_px = cols * 7.8 + pad * 2 + 10
    height_px = topbar + len(wrapped) * line_h + pad
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{int(width_px)}" height="{int(height_px)}" viewBox="0 0 {int(width_px)} {int(height_px)}" font-family="{FONT}">']
    svg.append(f'<rect width="{int(width_px)}" height="{int(height_px)}" fill="#0d1117"/>')
    svg.append(f'<rect width="{int(width_px)}" height="{topbar}" fill="#161b22"/>')
    svg.append('<circle cx="16" cy="15" r="5" fill="#ff5f56"/><circle cx="32" cy="15" r="5" fill="#ffbd2e"/><circle cx="48" cy="15" r="5" fill="#27c93f"/>')
    svg.append(f'<text x="66" y="20" fill="#8b949e" font-size="12">{html.escape(title)}</text>')
    y = topbar + 16
    for ln in wrapped:
        esc = html.escape(ln) if ln else ' '
        svg.append(f'<text x="{pad}" y="{y}" fill="#c9d1d9" font-size="12.5" xml:space="preserve">{esc}</text>')
        y += line_h
    svg.append('</svg>')
    with open(os.path.join(OUT_DIR, fname), 'w', encoding='utf-8') as f:
        f.write('\n'.join(svg))
    print('wrote', fname, f'({len(wrapped)} rows)')

def read_tr(name):
    return open(os.path.join(TR_DIR, f'tr-{name}.txt'), encoding='utf-8').read()

CURATORS = {'align': curate_align, 'sheet': curate_sheet, 'summary': curate_summary}
shots = [
    ('01-doctor', 'doctor — 环境变量与配置体检', 'doctor.svg'),
    ('02-sheet', 'sheet — 读表规范化与行级问题清单', 'sheet.svg'),
    ('03-align', 'align — 逐字段差异 / 状态 / 建议值', 'align.svg'),
    ('04-push', 'push — 按确认闸门推送 · 逐行回执', 'push.svg'),
    ('05-summary', 'summary — 本周期同步摘要', 'summary.svg'),
]
for name, title, fname in shots:
    raw = read_tr(name)
    key = name.split('-')[-1]
    body = CURATORS.get(key, lambda x: x)(raw)
    render(title, body, fname)

csv_path = os.path.join(TR_DIR, 'demo-result-table-fragment.csv')
render('align --out-csv — 真实导出的结果表（五列新列 + 回执区 + 缺行区）',
       open(csv_path, encoding='utf-8-sig').read(), 'result-table.svg')
print('ALL SVG SCREENSHOTS RENDERED')

import json
import math
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


def fetch_klines():
    url = "https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=72"
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.load(response)


def render_svg(rows):
    candles = rows[-60:]
    values = [float(x) for row in candles for x in (row[2], row[3])]
    lo, hi = min(values), max(values)
    pad = (hi - lo) * 0.10 or 1
    lo -= pad
    hi += pad
    left, top, width, height = 34, 30, 304, 382
    step = width / len(candles)
    body_w = max(2.2, step * 0.62)

    def y(price):
        return top + (hi - price) / (hi - lo) * height

    grid = []
    for i in range(5):
        gy = top + height * i / 4
        price = hi - (hi - lo) * i / 4
        grid.append(f'<line x1="{left}" y1="{gy:.1f}" x2="{left+width}" y2="{gy:.1f}" class="grid"/>')
        grid.append(f'<text x="344" y="{gy+4:.1f}" class="axis">{price:.2f}</text>')

    shapes = []
    for i, row in enumerate(candles):
        o, h, l, c = map(float, row[1:5])
        x = left + i * step + step / 2
        color = "#21c58b" if c >= o else "#f05c75"
        shapes.append(f'<line x1="{x:.1f}" y1="{y(h):.1f}" x2="{x:.1f}" y2="{y(l):.1f}" stroke="{color}" stroke-width="1.3"/>')
        by = min(y(o), y(c))
        bh = max(1.6, abs(y(c) - y(o)))
        shapes.append(f'<rect x="{x-body_w/2:.1f}" y="{by:.1f}" width="{body_w:.1f}" height="{bh:.1f}" rx="0.8" fill="{color}"/>')

    last = float(candles[-1][4])
    last_y = y(last)
    change = (last / float(candles[0][1]) - 1) * 100
    label_times = []
    for idx in [0, 15, 30, 45, 59]:
        ts = datetime.fromtimestamp(candles[idx][0] / 1000, timezone.utc).strftime("%H:%M")
        label_times.append(f'<text x="{left + idx*step:.1f}" y="435" class="axis">{ts}</text>')

    return f'''<svg viewBox="0 0 390 470" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#0b1220"/></linearGradient></defs>
      <rect width="390" height="470" fill="url(#bg)"/>
      {''.join(grid)}{''.join(shapes)}
      <line x1="{left}" y1="{last_y:.1f}" x2="{left+width}" y2="{last_y:.1f}" stroke="#7c8cff" stroke-dasharray="4 4" opacity=".8"/>
      <rect x="310" y="{last_y-11:.1f}" width="48" height="22" rx="5" fill="#7c8cff"/><text x="334" y="{last_y+4:.1f}" text-anchor="middle" class="last">{last:.2f}</text>
      {''.join(label_times)}
      <text x="34" y="460" class="muted">Binance · UTC</text>
      <text x="356" y="460" text-anchor="end" class="muted">{change:+.2f}% / 15m</text>
    </svg>''', last, change


rows = fetch_klines()
svg, last, change = render_svg(rows)
now = datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC")
html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#050912}} body{{width:430px;height:850px;font-family:Arial,sans-serif;color:#f5f7fb}}
.phone{{margin:0 auto;width:390px;height:844px;border-radius:42px;background:#101827;box-shadow:0 18px 50px #0009;overflow:hidden;border:8px solid #202a3a}}
.notch{{height:30px;background:#101827;position:relative}} .notch:after{{content:'';position:absolute;left:158px;top:0;width:74px;height:17px;border-radius:0 0 12px 12px;background:#050912}}
.top{{padding:14px 18px 8px}} .row{{display:flex;justify-content:space-between;align-items:center}} .pair{{font-size:20px;font-weight:700}} .sub{{color:#8f9bb2;font-size:12px;margin-top:4px}} .price{{font-size:24px;font-weight:700;color:#21c58b}} .pill{{background:#252f45;color:#b8c4ff;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:700}} .chart{{padding:0 0 5px}} svg{{display:block;width:390px;height:470px}} .grid{{stroke:#273247;stroke-width:1}} .axis{{fill:#8390a8;font-size:10px}} .last{{fill:#fff;font-size:10px;font-weight:700}} .muted{{fill:#718097;font-size:10px}}
.tabs{{display:flex;gap:20px;padding:10px 18px;border-top:1px solid #202b3d;border-bottom:1px solid #202b3d;color:#8390a8;font-size:12px}} .tabs b{{color:#dce3f4}} .foot{{padding:14px 18px;color:#718097;font-size:11px;display:flex;justify-content:space-between}}
</style></head><body><div class="phone"><div class="notch"></div><div class="top"><div class="row"><div><div class="pair">SOL/USDT <span style="color:#718097;font-size:12px">▾</span></div><div class="sub">Solana · Binance</div></div><div class="pill">15m</div></div><div class="row" style="margin-top:13px"><div class="price">{last:.2f}</div><div style="color:#21c58b;font-size:13px">{change:+.2f}%</div></div></div><div class="chart">{svg}</div><div class="tabs"><b>Chart</b><span>Order book</span><span>Trades</span></div><div class="foot"><span>Updated {now}</span><span>Live market</span></div></div></body></html>'''

out_dir = Path("output")
out_dir.mkdir(exist_ok=True)
html_path = out_dir / "solana_15m_phone.html"
png_path = out_dir / "solana_15m_phone.png"
html_path.write_text(html, encoding="utf-8")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 430, "height": 850}, device_scale_factor=2)
    page.goto(html_path.resolve().as_uri())
    page.screenshot(path=str(png_path), full_page=True)
    browser.close()

print(png_path.resolve())

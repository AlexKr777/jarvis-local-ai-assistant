from pathlib import Path
from playwright.sync_api import sync_playwright

url = "https://www.binance.com/en/trade/SOL_USDT?type=spot"
out = Path("output/binance_solana_15m_wide_chart.png")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1, locale="en-US")
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(12000)
    for label in ["Accept", "I understand", "Got it"]:
        try:
            page.get_by_text(label, exact=True).first.click(timeout=1200)
        except Exception:
            pass
    try:
        page.get_by_text("15m", exact=True).first.click(timeout=2500)
    except Exception:
        pass
    page.wait_for_timeout(3000)
    page.screenshot(path=str(out), full_page=False)
    print(out.resolve())
    browser.close()

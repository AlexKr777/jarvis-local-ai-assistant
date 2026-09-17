from pathlib import Path
from playwright.sync_api import sync_playwright

url = "https://www.binance.com/en/trade/SOL_USDT?type=spot"
out = Path("output/binance_solana_15m.png")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 430, "height": 900}, device_scale_factor=2, locale="en-US")
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(12000)
    for label in ["Accept", "I understand", "Got it"]:
        try:
            page.get_by_text(label, exact=True).first.click(timeout=1200)
        except Exception:
            pass
    # Binance's chart interval buttons are rendered dynamically; click the visible 15m control.
    for locator in [page.get_by_text("15m", exact=True), page.locator("button").filter(has_text="15m")]:
        try:
            locator.first.click(timeout=2500)
            break
        except Exception:
            pass
    page.wait_for_timeout(3000)
    page.screenshot(path=str(out), full_page=True)
    print(page.title())
    print(out.resolve())
    browser.close()

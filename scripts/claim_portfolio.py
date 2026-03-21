import argparse
import json
import os
import shutil
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT_DIR = Path(__file__).resolve().parents[1]
CHROME_USER_DATA = Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "User Data"
CHROME_EXECUTABLE_CANDIDATES = [
    Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ["PROGRAMFILES"]) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
]
TEMP_PROFILE_ROOT = ROOT_DIR / "data" / "browser"
PROFILE_COPY_ROOT = TEMP_PROFILE_ROOT / "chrome-profile-copy"
PORTFOLIO_URL = "https://polymarket.com/zh/portfolio"
RESULT_PATH = TEMP_PROFILE_ROOT / "claim-result.json"
SCREENSHOT_PATH = TEMP_PROFILE_ROOT / "claim-portfolio.png"
NETWORK_LOG_PATH = TEMP_PROFILE_ROOT / "claim-network.json"

CLAIM_BUTTON_TEXTS = ["领取", "Claim", "主张", "兑换"]
CONFIRM_BUTTON_TEXTS = ["Claim", "领取", "确认", "兑换", "索赔"]
SUCCESS_TEXTS = ["已添加到账户", "added to your account", "处理完成", "搞定"]
DONE_BUTTON_TEXTS = ["搞定", "完成", "Done", "OK", "知道了"]


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def resolve_chrome_executable() -> Path:
    for candidate in CHROME_EXECUTABLE_CANDIDATES:
        if str(candidate) and candidate.exists():
            return candidate
    raise RuntimeError(
        "Chrome executable not found in supported locations: "
        + ", ".join(str(candidate) for candidate in CHROME_EXECUTABLE_CANDIDATES if str(candidate))
    )


def profile_copy_has_login(profile_name: str) -> bool:
    return (
        (PROFILE_COPY_ROOT / profile_name / "Network" / "Cookies").exists()
        or (PROFILE_COPY_ROOT / profile_name / "Cookies").exists()
    )


def prepare_profile_copy(profile_name: str, refresh: bool = False) -> Path:
    ensure_dir(TEMP_PROFILE_ROOT)
    if PROFILE_COPY_ROOT.exists() and not refresh and profile_copy_has_login(profile_name):
        return PROFILE_COPY_ROOT

    if PROFILE_COPY_ROOT.exists():
        shutil.rmtree(PROFILE_COPY_ROOT)
    PROFILE_COPY_ROOT.mkdir(parents=True, exist_ok=True)

    local_state = CHROME_USER_DATA / "Local State"
    if local_state.exists():
        shutil.copy2(local_state, PROFILE_COPY_ROOT / "Local State")

    source_profile = CHROME_USER_DATA / profile_name
    if not source_profile.exists():
        raise RuntimeError(f"Chrome profile not found: {source_profile}")

    ignored = shutil.ignore_patterns(
        "Cache",
        "Code Cache",
        "GPUCache",
        "GrShaderCache",
        "ShaderCache",
        "Service Worker/CacheStorage",
        "Service Worker/ScriptCache",
        "OptimizationGuidePredictionModels",
        "DawnCache",
        "Crashpad",
    )

    try:
        shutil.copytree(
            source_profile,
            PROFILE_COPY_ROOT / profile_name,
            dirs_exist_ok=True,
            ignore=ignored,
        )
    except shutil.Error:
        # Best-effort copy when Chrome is locking live files.
        for src_root, dir_names, file_names in os.walk(source_profile):
            src_root_path = Path(src_root)
            relative = src_root_path.relative_to(source_profile)
            dst_root_path = PROFILE_COPY_ROOT / profile_name / relative
            dst_root_path.mkdir(parents=True, exist_ok=True)
            for dir_name in list(dir_names):
                if dir_name in {
                    "Cache",
                    "Code Cache",
                    "GPUCache",
                    "ShaderCache",
                    "GrShaderCache",
                    "Crashpad",
                }:
                    dir_names.remove(dir_name)
            for file_name in file_names:
                src_file = src_root_path / file_name
                dst_file = dst_root_path / file_name
                try:
                    shutil.copy2(src_file, dst_file)
                except Exception:
                    continue

    return PROFILE_COPY_ROOT


def button_selector(texts) -> str:
    return ", ".join(f"button:has-text('{text}')" for text in texts)


def visible_text(locator) -> str:
    try:
        if locator.count() == 0:
            return ""
        return (locator.first.inner_text(timeout=2000) or "").strip()
    except Exception:
        return ""


def find_text_presence(page, texts) -> list[str]:
    found = []
    for text in texts:
        try:
            locator = page.locator(f"text={text}")
            if locator.count() > 0 and locator.first.is_visible():
                found.append(text)
        except Exception:
            continue
    return found


def detect_claim_state(page) -> dict:
    claim_button = page.locator(button_selector(CLAIM_BUTTON_TEXTS))
    portfolio_value = visible_text(page.locator("body"))
    success_hits = find_text_presence(page, SUCCESS_TEXTS)
    buttons = []
    try:
        for index in range(min(claim_button.count(), 8)):
            label = (claim_button.nth(index).inner_text(timeout=1500) or "").strip()
            if label:
                buttons.append(label)
    except Exception:
        pass

    lines = [line.strip() for line in portfolio_value.splitlines() if line.strip()]
    return {
        "claimButtonCount": claim_button.count(),
        "claimButtons": buttons,
        "portfolioTextLines": lines[:30],
        "successTexts": success_hits,
        "canClaim": claim_button.count() > 0,
    }


def is_interesting_url(url: str) -> bool:
    interesting_domains = (
        "polymarket.com",
        "clob.polymarket.com",
        "data-api.polymarket.com",
        "gamma-api.polymarket.com",
        "relayer",
    )
    boring_suffixes = (".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2", ".css", ".ico")
    return any(domain in url for domain in interesting_domains) and not url.endswith(boring_suffixes)


def build_network_logger(page):
    network_events = []

    def on_request(request):
        url = request.url
        if request.method != "GET" or is_interesting_url(url):
            post_data = None
            try:
                post_data = request.post_data
            except Exception:
                post_data = "<unavailable-binary-payload>"
            network_events.append(
                {
                    "kind": "request",
                    "timestamp": time.time(),
                    "method": request.method,
                    "resourceType": request.resource_type,
                    "url": url,
                    "postData": post_data,
                }
            )

    def on_response(response):
        url = response.url
        if response.request.method != "GET" or is_interesting_url(url):
            headers = {}
            try:
                headers = response.headers
            except Exception:
                headers = {}
            network_events.append(
                {
                    "kind": "response",
                    "timestamp": time.time(),
                    "method": response.request.method,
                    "resourceType": response.request.resource_type,
                    "url": url,
                    "status": response.status,
                    "contentType": headers.get("content-type"),
                }
            )

    page.on("request", on_request)
    page.on("response", on_response)
    return network_events


def click_claim(page) -> dict:
    primary_claim = page.locator(button_selector(["领取", "Claim", "主张"]))
    if primary_claim.count() == 0:
        primary_claim = page.locator(button_selector(["兑换"]))
    if primary_claim.count() == 0:
        return {"clicked": False, "reason": "no claim button found"}

    before = detect_claim_state(page)
    primary_claim.first.click(timeout=10000)
    page.wait_for_timeout(2000)

    dialog = page.locator("[role='dialog']")
    dialog_confirm = dialog.locator(button_selector(CONFIRM_BUTTON_TEXTS))

    if dialog.count() > 0 and dialog_confirm.count() > 0:
        dialog_confirm.first.click(timeout=10000)
        page.wait_for_timeout(3000)

    success_dialog = page.locator("[role='dialog']")
    success_before_done = {
        "texts": find_text_presence(page, SUCCESS_TEXTS),
        "doneButtons": [],
    }
    done_locator = success_dialog.locator(button_selector(DONE_BUTTON_TEXTS))
    try:
        for index in range(min(done_locator.count(), 5)):
            label = (done_locator.nth(index).inner_text(timeout=1000) or "").strip()
            if label:
                success_before_done["doneButtons"].append(label)
    except Exception:
        pass

    if done_locator.count() > 0:
        try:
            done_locator.first.click(timeout=5000)
            page.wait_for_timeout(1500)
        except Exception:
            pass

    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PlaywrightTimeoutError:
        pass
    page.wait_for_timeout(3000)

    after = detect_claim_state(page)
    return {
        "clicked": True,
        "before": before,
        "after": after,
        "successDetected": bool(success_before_done["texts"]) or (before.get("canClaim") and not after.get("canClaim")),
        "successBeforeDone": success_before_done,
    }


def run(profile_name: str, execute: bool, headless: bool, refresh_profile_copy: bool) -> dict:
    chrome_executable = resolve_chrome_executable()
    ensure_dir(TEMP_PROFILE_ROOT)

    profile_mode = "copied"
    profile_root = prepare_profile_copy(profile_name, refresh=refresh_profile_copy)

    with sync_playwright() as playwright:
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            f"--profile-directory={profile_name}",
        ]

        user_data_dir = str(profile_root)
        if not profile_copy_has_login(profile_name):
            profile_mode = "live"
            user_data_dir = str(CHROME_USER_DATA)

        context = playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            executable_path=str(chrome_executable),
            headless=headless,
            args=launch_args,
            viewport={"width": 1600, "height": 1100},
            locale="zh-CN",
        )
        page = context.new_page()
        network_events = build_network_logger(page)
        page.goto(PORTFOLIO_URL, wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_load_state("networkidle", timeout=30000)
        except PlaywrightTimeoutError:
            pass
        page.wait_for_timeout(5000)

        state = detect_claim_state(page)
        result = {
            "profileName": profile_name,
            "profileMode": profile_mode,
            "chromeExecutable": str(chrome_executable),
            "execute": execute,
            "headless": headless,
            "state": state,
            "claimed": None,
            "networkEventCount": len(network_events),
        }

        if execute and state.get("canClaim"):
            result["claimed"] = click_claim(page)
            page.wait_for_timeout(5000)
            result["finalState"] = detect_claim_state(page)
        else:
            result["finalState"] = state

        page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)
        context.close()

    RESULT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    NETWORK_LOG_PATH.write_text(json.dumps(network_events, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Polymarket portfolio claim tester")
    parser.add_argument("--profile", default="Default", help="Chrome profile name")
    parser.add_argument("--execute", action="store_true", help="Click the claim button if found")
    parser.add_argument("--headful", action="store_true", help="Run visible browser instead of headless")
    parser.add_argument(
        "--refresh-profile-copy",
        action="store_true",
        help="Refresh the copied Chrome profile before running",
    )
    args = parser.parse_args()

    result = run(
        profile_name=args.profile,
        execute=args.execute,
        headless=not args.headful,
        refresh_profile_copy=args.refresh_profile_copy,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

import os
import sys
import random
import time
import argparse
from playwright.sync_api import sync_playwright
import util
import db
import log

def run_stealth_pass():
    parser = argparse.ArgumentParser()
    parser.add_argument("--venue", required=True)
    args = parser.parse_args()
    venue_id = args.venue

    active_venue = util.get_venue_config(venue_id)
    if not active_venue:
        print(f"Error: Venue '{venue_id}' configuration missing from Upstash Portal.")
        sys.exit(1)
        
    if util.check_global_kill_switch(venue_id):
        print("Admin Portal Intercept: Venue status toggled OFF. Exiting.")
        return

    is_safe, decimal_time, today_date_str = util.check_curfew_safety_gate(active_venue["timezone"])
    if not is_safe:
        return

    log.emit_activity_log(venue_id, "Shift Started - Syncing cache landmarks...", alert_type="SYSTEM", target_tz=active_venue["timezone"])

    resume_index = util.resolve_resume_index(venue_id, today_date_str)
    if resume_index == "COMPLETED":
        return

    surfsky_token = os.getenv("SURFSKY_API_TOKEN")
    if not surfsky_token:
        sys.exit(1)

    cdp_url = f"wss://browser.surfsky.io/v1?token={surfsky_token}&stealth=true&captcha_solver=true&device=desktop&os=windows"
    
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp_url)
            context = browser.new_context(viewport={"width": random.randint(1366, 1920), "height": random.randint(768, 1080)}, has_touch=False)
            
            calendar_page = context.new_page()
            calendar_page.goto(active_venue["calendar_url"], wait_until="networkidle")
            
            calendar_page.wait_for_selector(active_venue["selector_wait_for"], timeout=12000)
            event_cards = calendar_page.locator(active_venue["locator_card_element"], has=calendar_page.locator(active_venue["locator_button_text"]))
            count = event_cards.count()

            if resume_index >= count:
                util.update_progress_marker(venue_id, today_date_str, 0, is_complete=True)
                log.emit_activity_log(venue_id, f"Scan Cycle Complete: Successfully verified all {count} rows.", alert_type="SCAN", target_tz=active_venue["timezone"])
                calendar_page.close()
                return

            max_checks_this_run = int(os.getenv("MAX_CHECKS_PER_RUN", "3"))
            checks_completed = 0

            for i in range(resume_index, count):
                if util.check_global_kill_switch(venue_id):
                    break
                if checks_completed >= max_checks_this_run:
                    break

                card = event_cards.nth(i)
                text = card.inner_text()
                date_label = (text.split('\n') if '\n' in text else f"Show #{i+1}").strip()
                clean_show_id = "".join(e for e in date_label.split(" ") if e.isalnum()).lower()
                
                if util.check_show_kill_switch(venue_id, date_label):
                    util.update_progress_marker(venue_id, today_date_str, i + 1, is_complete=(i == count - 1))
                    continue

                db.set_active_pointer(venue_id, f"Checking row [{i}]: {date_label}")
                axs_page = None

                try:
                    with context.expect_page() as page_catcher:
                        card.locator(active_venue["locator_button_text"]).first.click()
                    
                    axs_page = page_catcher.value
                    axs_page.wait_for_load_state("domcontentloaded")
                    
                    if "waitingroom" in axs_page.url or "queue" in axs_page.url:
                        db.update_show_status_buffer(venue_id, clean_show_id, "Waiting Room Queue Hit", 0)
                        util.dispatch_technical_log(
                            venue_id=venue_id,
                            message=f"{date_label} - Stuck in queue waiting room.",
                            alert_type="QUEUE",
                            alert_level="CRITICAL",
                            target_tz=active_venue["timezone"]
                        )
                        checks_completed += 1
                        continue

                    axs_page.mouse.move(random.randint(150, 500), random.randint(150, 500), steps=4)
                    axs_page.reload(wait_until="domcontentloaded")
                    
                    axs_map = axs_page.locator(active_venue["inventory_container_selector"])
                    if axs_map.count() == 0:
                        db.update_show_status_buffer(venue_id, clean_show_id, "Layout Selector Missing", 0)
                        util.dispatch_technical_log(
                            venue_id=venue_id,
                            message=f"{date_label} - Element layout mutation seen.",
                            alert_type="MUTATION",
                            alert_level="WARNING",
                            target_tz=active_venue["timezone"]
                        )
                        continue

                    body_text = axs_page.inner_text("body")
                    is_sold_out = any(sig in body_text for sig in active_venue["sold_out_signatures"])

                    if is_sold_out:
                        util.track_velocity_and_alert(venue_id, active_venue["name"], date_label, clean_show_id, "Verified Sold Out", 0, active_venue["timezone"])
                    else:
                        available_pins = axs_page.locator(".ticket-pin, .seat-dot, .available-row, .ticket-row").count()
                        seat_count = max(available_pins, 1)
                        util.track_velocity_and_alert(venue_id, active_venue["name"], date_label, clean_show_id, "Tickets Available", seat_count, active_venue["timezone"])
                    
                    checks_completed += 1
                    util.update_progress_marker(venue_id, today_date_str, i + 1, is_complete=(i == count - 1))

                except Exception as loop_error:
                    error_str = str(loop_error).lower()
                    if "captcha" in error_str or "timeout" in error_str:
                        db.update_show_status_buffer(venue_id, clean_show_id, "Captcha Obstacle Triggered", 0)
                        util.dispatch_technical_log(
                            venue_id=venue_id,
                            message=f"{date_label} - Hit security challenge wall.",
                            alert_type="CAPTCHA",
                            alert_level="WARNING",
                            target_tz=active_venue["timezone"]
                        )
                    else:
                        db.update_show_status_buffer(venue_id, clean_show_id, "Page Timeout Exception", 0)
                    util.update_progress_marker(venue_id, today_date_str, i + 1, is_complete=(i == count - 1))
                finally:
                    if axs_page:
                        try: axs_page.close()
                        except: pass

                time.sleep(random.uniform(5.0, 10.0))

            calendar_page.close()

        except Exception as global_err:
            log.emit_activity_log(venue_id, f"Infrastructure Pipeline Fault: {global_err}", alert_type="SYSTEM", alert_level="FATAL", target_tz=active_venue["timezone"])
        finally:
            print("Workflow execution segment finished.")

if __name__ == "__main__":
    run_stealth_pass()

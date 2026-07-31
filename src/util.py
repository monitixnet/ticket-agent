import os
from datetime import datetime
import zoneinfo
import db
import alert
import log

def get_venue_config(venue_id):
    return db.fetch_venue_configuration(venue_id)

def check_global_kill_switch(venue_id):
    return db.fetch_venue_status(venue_id) == "OFF"

def check_show_kill_switch(venue_id, date_label):
    clean_show_id = "".join(e for e in date_label.split(" ") if e.isalnum()).lower()
    return db.fetch_show_status(venue_id, clean_show_id) == "OFF"

def check_curfew_safety_gate(target_tz_str):
    start_hour = float(os.getenv("GUARDRAIL_START_HOUR", "7.5"))
    end_hour = float(os.getenv("GUARDRAIL_END_HOUR", "23.0"))
    try:
        tz = zoneinfo.ZoneInfo(target_tz_str)
        local_now = datetime.now(tz)
    except Exception:
        tz = zoneinfo.ZoneInfo("UTC")
        local_now = datetime.now(tz)
    decimal_time = local_now.hour + (local_now.minute / 60.0)
    today_date_str = local_now.strftime('%Y-%m-%d')
    return start_hour <= decimal_time < end_hour, decimal_time, today_date_str

def resolve_resume_index(venue_id, today_date_str):
    cached_date, last_processed_cache = db.fetch_tracking_milestones(venue_id)
    if cached_date == today_date_str and last_processed_cache == "completed_today":
        return "COMPLETED"
    if cached_date != today_date_str:
        print("New Day Horizon: Resetting tracking indexes back to 0.")
        db.commit_tracking_milestone(venue_id, today_date_str, "0")
        return 0
    return int(last_processed_cache) if last_processed_cache and last_processed_cache.isdigit() else 0

def update_progress_marker(venue_id, today_date_str, index_val, is_complete=False):
    marker = "completed_today" if is_complete else str(index_val)
    db.commit_tracking_milestone(venue_id, today_date_str, marker)

def track_velocity_and_alert(venue_id, venue_name, date_label, clean_show_id, text_status, seat_count, target_tz):
    delta = db.update_show_status_buffer(venue_id, clean_show_id, text_status, seat_count)
    
    if delta >= 5:
        alert.dispatch_alert(venue_name, f"{date_label} (+{delta} dropped!)", alert_type="DROP", alert_level="CRITICAL")
    elif seat_count > 0:
        alert.dispatch_alert(venue_name, f"{date_label} ({seat_count} seats)", alert_type="INVENTORY", alert_level="CRITICAL")
        
    log.emit_activity_log(
        venue_id=venue_id,
        message=f"Checked row: {date_label} | {text_status} [Count: {seat_count}, Delta: {delta}]",
        alert_type="INVENTORY" if seat_count > 0 else "SCAN",
        alert_level="CRITICAL" if seat_count > 0 else "INFO",
        target_tz=target_tz
    )

def dispatch_technical_log(venue_id, message, alert_type, alert_level, target_tz):
    log.emit_activity_log(
        venue_id=venue_id,
        message=message,
        alert_type=alert_type,
        alert_level=alert_level,
        target_tz=target_tz
    )

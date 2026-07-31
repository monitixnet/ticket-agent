import zoneinfo
from datetime import datetime
import db

def emit_activity_log(venue_id, message, alert_type="SCAN", alert_level="INFO", target_tz="America/Chicago"):
    """Formats system events into text-only logs and saves them silently to the Upstash buffer."""
    try:
        tz = zoneinfo.ZoneInfo(target_tz)
        local_now = datetime.now(tz)
    except Exception:
        local_now = datetime.now()
        
    timestamp = local_now.strftime('%I:%M %p')
    
    if alert_level == "FATAL":
        prefix = "CRITICAL FAULT:"
    elif alert_type == "SYSTEM":
        prefix = "SYSTEM:"
    elif alert_type == "SCAN":
        prefix = "SCAN:"
    elif alert_type == "QUEUE":
        prefix = "Waiting Room:"
    elif alert_type == "MUTATION":
        prefix = "Layout Shift:"
    elif alert_type == "CAPTCHA":
        prefix = "Security Challenge:"
    else:
        prefix = "CHECK:"

    readable_log = f"[{timestamp}] {prefix} {message}"
    db.push_to_activity_buffer(f"ticket_agent:{venue_id}:activity_log", readable_log)

import os
import requests

NOTIFICATION_WEBHOOK_URL = os.getenv("NOTIFICATION_WEBHOOK_URL")

def dispatch_alert(venue_name, event_label, alert_type="INVENTORY", alert_level="CRITICAL"):
    """STRICTLY ACTION-ONLY PAYLOAD ROUTER.
    
    Filters out technical, structural, and system metrics completely to prevent notification fatigue.
    """
    if alert_type not in ["INVENTORY", "DROP"]:
        return

    if not NOTIFICATION_WEBHOOK_URL:
        print("Alert triggered, but NOTIFICATION_WEBHOOK_URL secret is missing.")
        return
        
    level_tag = "[CRITICAL]"

    if alert_type == "INVENTORY":
        message = (
            f"SEATS OPENED {level_tag}\n\n"
            f"Venue: {venue_name}\n"
            f"Event: {event_label}\n"
            f"Status: Scattered public tickets verified online."
        )
    elif alert_type == "DROP":
        message = (
            f"TICKET DROP ALARM {level_tag}\n\n"
            f"Venue: {venue_name}\n"
            f"Event: {event_label}\n"
            f"Drop Velocity: Surge detected!\n"
            f"Action required: Open your app and checkout instantly!"
        )
    else:
        return

    try:
        requests.get(f"{NOTIFICATION_WEBHOOK_URL}{requests.util.quote(message)}", timeout=10)
        print(f"Action Alert dispatched through pipeline. Type: {alert_type}")
    except Exception as e:
        print(f"Failed to transmit notification payload: {e}")

import os
import json
import requests

REDIS_URL = os.getenv("UPSTASH_REDIS_REST_URL")
REDIS_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN")

def query_cloud_cache(command, key, value=None):
    """Executes atomic Key-Value REST queries straight to the Upstash endpoint."""
    if not REDIS_URL or not REDIS_TOKEN:
        print("Warning: Missing cloud database environment credentials.")
        return None
    headers = {"Authorization": f"Bearer {REDIS_TOKEN}"}
    url = f"{REDIS_URL}/{command}/{key}"
    if value is not None:
        url += f"/{value}"
    try:
        response = requests.get(url, headers=headers, timeout=5).json()
        return response.get("result")
    except Exception as e:
        print(f"Cache pipeline communication timeout: {e}")
        return None

def fetch_venue_configuration(venue_id):
    """Loads the entire target venue layout mapping definition from Upstash."""
    raw_json = query_cloud_cache("GET", f"ticket_agent:config:{venue_id}")
    if not raw_json:
        return None
    try:
        return json.loads(raw_json)
    except Exception:
        print(f"Failed to parse JSON configuration mapping for '{venue_id}'")
        return None

def fetch_venue_status(venue_id):
    return query_cloud_cache("GET", f"ticket_agent:{venue_id}:status")

def fetch_show_status(venue_id, clean_show_id):
    return query_cloud_cache("GET", f"ticket_agent:{venue_id}:show:{clean_show_id}:status")

def fetch_tracking_milestones(venue_id):
    date_key = f"ticket_agent:{venue_id}:last_run_date"
    index_key = f"ticket_agent:{venue_id}:last_processed_index"
    return query_cloud_cache("GET", date_key), query_cloud_cache("GET", index_key)

def commit_tracking_milestone(venue_id, date_str, index_val):
    date_key = f"ticket_agent:{venue_id}:last_run_date"
    index_key = f"ticket_agent:{venue_id}:last_processed_index"
    query_cloud_cache("SET", date_key, date_str)
    query_cloud_cache("SET", index_key, str(index_val))

def set_active_pointer(venue_id, text_label):
    query_cloud_cache("SET", f"ticket_agent:{venue_id}:active_pointer", text_label)

def update_show_status_buffer(venue_id, clean_show_id, text_status, current_seat_count=0):
    """Updates the status and calculates real-time inventory velocity vectors inside a single Redis Hash row."""
    hash_key = f"ticket_agent:{venue_id}:show:{clean_show_id}"
    
    previous_count_raw = query_cloud_cache("HGET", hash_key, "last_available_count")
    previous_count = int(previous_count_raw) if previous_count_raw and str(previous_count_raw).isdigit() else 0
    
    delta = current_seat_count - previous_count if previous_count > 0 else current_seat_count
    
    highest_raw = query_cloud_cache("HGET", hash_key, "highest_seen_count")
    highest_seen = int(highest_raw) if highest_raw and str(highest_raw).isdigit() else 0
    new_highest = max(current_seat_count, highest_seen)

    query_cloud_cache("HSET", hash_key, f"last_result {text_status}")
    query_cloud_cache("HSET", hash_key, f"last_available_count {current_seat_count}")
    query_cloud_cache("HSET", hash_key, f"inventory_delta {delta}")
    query_cloud_cache("HSET", hash_key, f"highest_seen_count {new_highest}")
    query_cloud_cache("HINCRBY", hash_key, "check_count 1")
    
    return delta

def push_to_activity_buffer(buffer_key, readable_log):
    """Pushes a readable log line to the front of your Redis history list and truncates trailing rows."""
    query_cloud_cache("LPUSH", buffer_key, readable_log)
    query_cloud_cache("LTRIM", buffer_key, "0/49")

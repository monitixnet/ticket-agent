-- 1. Master Venues Table
CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state_code TEXT NOT NULL,
    timezone_name TEXT NOT NULL DEFAULT 'UTC',
    security_tier TEXT NOT NULL DEFAULT 'low'
);

-- 2. Nodal Parent Shows Table
CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    show_name TEXT NOT NULL,
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

-- 3. Time-Aware Event Instances Table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    show_id TEXT NOT NULL,
    showtime TEXT NOT NULL, -- Stored as ISO 8601 UTC string
    event_url TEXT, -- This will be the direct link to the ticketing page for the event
    last_snapshot_hash TEXT,
    last_scanned_at TIMESTAMP,
    FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE
);

-- 4. Granular Listings Table (Your Active Inventory Assets)
CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    section_label TEXT NOT NULL,
    row_label TEXT NOT NULL,
    seat_label TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    skybox_listing_id TEXT NOT NULL,
    current_state TEXT DEFAULT 'ACTIVE',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- 5. State Machine Pointers
CREATE TABLE IF NOT EXISTS system_state (
    key_name TEXT PRIMARY KEY,
    value_string TEXT NOT NULL
);

-- 6. Durable Scan Work Queue
CREATE TABLE IF NOT EXISTS scan_jobs (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    event_id TEXT,
    job_type TEXT NOT NULL DEFAULT 'venue_scan',
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_checkpoint TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Persisted Worker Logs
CREATE TABLE IF NOT EXISTS worker_logs (
    id TEXT PRIMARY KEY,
    timestamp DATETIME NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

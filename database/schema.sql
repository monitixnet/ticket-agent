-- 1. Master Venues Table
CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state_code TEXT NOT NULL,
    timezone_name TEXT NOT NULL DEFAULT 'UTC',
    security_tier TEXT NOT NULL DEFAULT 'low'
);

-- Runtime venue adapters are data, not application code. Credentials are
-- references to Worker secrets, never secret values.
CREATE TABLE IF NOT EXISTS venue_runtime_configs (
    venue_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'paused')) DEFAULT 'draft',
    config_json TEXT NOT NULL,
    credential_refs_json TEXT NOT NULL DEFAULT '{}',
    config_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_venue_runtime_configs_status ON venue_runtime_configs(status);

-- 2. Nodal Parent Shows Table
CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    show_name TEXT NOT NULL,
    UNIQUE (venue_id, show_name),
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

-- 3. Time-Aware Event Instances Table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    show_id TEXT NOT NULL,
    showtime TEXT NOT NULL, -- Stored as ISO 8601 UTC string
    event_url TEXT, -- This will be the direct link to the ticketing page for the event
    venue_hall TEXT, -- Optional hall/room override for venue moves or reassignments
    venue_hall_id TEXT, -- Stable FK into the venue hall registry when known
    last_snapshot_hash TEXT,
    last_scanned_at TIMESTAMP,
    FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE
);

-- Venue halls are venue-scoped because sections, pricing tiers, and layouts
-- are hall-specific. Only non-secret operational metadata belongs here.
CREATE TABLE IF NOT EXISTS venue_halls (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    capacity INTEGER,
    seating_layout_key TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (venue_id, canonical_name),
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS venue_hall_sections (
    id TEXT PRIMARY KEY,
    venue_hall_id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    sort_order INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (venue_hall_id, canonical_name),
    FOREIGN KEY(venue_hall_id) REFERENCES venue_halls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS venue_hall_rows (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL,
    row_label TEXT NOT NULL,
    sort_order INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (section_id, row_label),
    FOREIGN KEY(section_id) REFERENCES venue_hall_sections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS venue_hall_seats (
    id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL,
    seat_label TEXT NOT NULL,
    seat_number INTEGER,
    quality_zone TEXT NOT NULL DEFAULT 'unclassified' CHECK(quality_zone IN ('center', 'left', 'right', 'side', 'limited_view', 'not_applicable', 'unclassified')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (row_id, seat_label),
    FOREIGN KEY(row_id) REFERENCES venue_hall_rows(id) ON DELETE CASCADE
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_skybox_listing_id ON listings(skybox_listing_id);
CREATE INDEX IF NOT EXISTS idx_events_showtime ON events(showtime);
CREATE INDEX IF NOT EXISTS idx_events_last_scanned_at ON events(last_scanned_at);
CREATE INDEX IF NOT EXISTS idx_events_venue_hall_id ON events(venue_hall_id);

-- Immutable observations of live inventory. The current scan marker remains on
-- events for scheduling; these tables retain the actual parsed result.
CREATE TABLE IF NOT EXISTS inventory_scans (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    scan_source TEXT NOT NULL,
    scanned_at DATETIME NOT NULL,
    snapshot_hash TEXT NOT NULL,
    available_item_count INTEGER NOT NULL,
    inventory_job_id TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    candidate_block_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_candidate_blocks (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    target_quantity INTEGER NOT NULL CHECK(target_quantity > 0),
    section_label TEXT NOT NULL,
    row_label TEXT NOT NULL,
    start_seat_label TEXT NOT NULL,
    end_seat_label TEXT NOT NULL,
    price_level TEXT,
    seat_quality TEXT,
    price_cents INTEGER,
    position_zone TEXT NOT NULL DEFAULT 'unclassified',
    target_seats_json TEXT NOT NULL,
    buffer_blocks_json TEXT NOT NULL,
    FOREIGN KEY(scan_id) REFERENCES inventory_scans(id) ON DELETE CASCADE,
);

CREATE INDEX IF NOT EXISTS idx_inventory_scans_event_scanned ON inventory_scans(event_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_candidate_blocks_scan ON inventory_candidate_blocks(scan_id, target_quantity, section_label, row_label);
CREATE INDEX IF NOT EXISTS idx_inventory_scans_job_scanned ON inventory_scans(inventory_job_id, scanned_at DESC);

-- High-priority sold-out drop monitoring. These tables are intentionally
-- separate from candidate blocks: a drop means any verified available seat.
CREATE TABLE IF NOT EXISTS inventory_watch_rules (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    show_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    scan_interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(scan_interval_minutes BETWEEN 1 AND 120),
    max_price_cents INTEGER CHECK(max_price_cents IS NULL OR max_price_cents >= 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(venue_id, show_name),
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_inventory_state (
    event_id TEXT PRIMARY KEY,
    availability_state TEXT NOT NULL CHECK(availability_state IN ('unknown', 'sold_out', 'available')),
    available_item_count INTEGER NOT NULL DEFAULT 0,
    last_scan_id TEXT,
    last_observed_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(last_scan_id) REFERENCES inventory_scans(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory_drop_alerts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed')),
    payload_json TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at DATETIME,
    delivered_at DATETIME,
    last_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, scan_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(scan_id) REFERENCES inventory_scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watch_rules_active ON inventory_watch_rules(venue_id, enabled, show_name);
CREATE INDEX IF NOT EXISTS idx_drop_alerts_delivery ON inventory_drop_alerts(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS inventory_jobs (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'paused')),
    remaining_event_ids_json TEXT NOT NULL,
    total_event_count INTEGER NOT NULL,
    completed_event_count INTEGER NOT NULL DEFAULT 0,
    failed_event_count INTEGER NOT NULL DEFAULT 0,
    skipped_event_count INTEGER NOT NULL DEFAULT 0,
    batch_count INTEGER NOT NULL DEFAULT 0,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    lease_owner TEXT,
    lease_expires_at DATETIME,
    last_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_jobs_one_running_per_venue ON inventory_jobs(venue_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS inventory_job_batches (
    id TEXT PRIMARY KEY,
    inventory_job_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    batch_number INTEGER NOT NULL,
    started_at DATETIME NOT NULL,
    completed_at DATETIME NOT NULL,
    duration_ms INTEGER NOT NULL,
    attempted_event_count INTEGER NOT NULL,
    completed_event_count INTEGER NOT NULL,
    failed_event_count INTEGER NOT NULL,
    skipped_event_count INTEGER NOT NULL,
    remaining_event_count INTEGER NOT NULL,
    FOREIGN KEY(inventory_job_id) REFERENCES inventory_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_job_batches_job_number ON inventory_job_batches(inventory_job_id, batch_number);

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

-- 8. Durable time-series data for the external discovery dashboard.
CREATE TABLE IF NOT EXISTS discovery_batch_metrics (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    started_at DATETIME NOT NULL,
    completed_at DATETIME NOT NULL,
    duration_ms INTEGER NOT NULL,
    processed_production_count INTEGER NOT NULL,
    discovered_event_count INTEGER NOT NULL,
    inserted_event_count INTEGER NOT NULL,
    failed_production_count INTEGER NOT NULL DEFAULT 0,
    remaining_production_count INTEGER NOT NULL,
    total_production_count INTEGER NOT NULL,
    outcome_counts_json TEXT NOT NULL DEFAULT '{}',
    job_run_number INTEGER NOT NULL,
    estimated_runs_remaining INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_metrics_venue_completed
  ON discovery_batch_metrics(venue_id, completed_at DESC);

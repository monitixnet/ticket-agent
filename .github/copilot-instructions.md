# Ticket Agent Copilot Instructions

## Project purpose
This repository is a ticket monitoring and validation system for live event inventory. The system must monitor venue and ticketing sources, verify section/row/seat availability, and only approve listings when inventory confidence is high enough to avoid false positives.

## Core business rules
- The system must treat inventory validation as a safety-first workflow, not a best-effort scrape.
- A single available seat is never sufficient to approve a listing.
- The system must verify the exact event, venue, section, row, seat, and price parity before action.
- For any listing order, the system must require a confidence buffer of 3X before listing tickets on Skybox or Vivid Seats.
- The system must support a monitoring-only mode that disables outbound listing approval while validation continues running in test mode.
- The default production posture should be monitoring-only until the venue source coverage and validation logic has been fully vetted.
- The system must not build or depend on a real Skybox or Vivid Seats listing API integration in this phase.
- The system must not approve or publish live outbound listings while it is in monitoring-only validation mode.
- The required buffer formula is:
  - target quantity = X
  - backup set 1 = X
  - backup set 2 = X
  - minimum valid equivalent inventory = 3X
- The system must require equivalent inventory to match the same venue, same event, same section, same price level, and same seat quality profile as the target listing.
- Price parity and section parity are mandatory. Do not approve inventory when the available seats are not equivalent in value and location.
- If the exact target inventory is unavailable, the system may consider equivalent fallback inventory only when it still satisfies the 3X confidence rule.
- Any seat count below 3X for the target quantity must be treated as insufficient inventory and should be rejected or held.

## Monitoring hours guardrail
- The system must operate only within the configured active business window.
- Default operational window: 7:30 AM to 10:30 PM local venue time.
- No live monitoring or validation should run outside this window unless explicitly overridden by a business exception.
- Off-hours scans should be skipped and logged as non-operational instead of acting on stale or partial inventory.
- The scheduled worker should enforce the active window before performing any fetch, scan, validation, or listing action.
- Monitoring should be scheduled in short, staggered, venue-aware intervals during the active window rather than a single rigid cadence.
- The worker should include jitter or randomized delay to avoid predictable traffic patterns that may trigger rate limiting or blocking.
- If a site begins to block or rate-limit requests, the worker should slow down the interval and back off instead of continuing a fixed pattern.

## Venue and source handling
- Venue-specific parsing and seat-layout logic is required because each venue has different seating maps, sections, ticket classes, and pricing rules.
- Treat Broadway.com, BroadwayDirect.com, and venue-specific ticketing portals as separate source adapters with separate parsing rules.
- Source adapters must normalize inventory into a common internal schema before validation.
- Venue-specific seat map rules must be preserved and never flattened into a generic one-size-fits-all assumption.
- Current milestone requirement: every active venue must have a source adapter contract with a source URL pattern, required inventory fields, section/seat normalization rules, freshness checks, and a smoke-test matrix before the validation loop is considered production-ready.
- The active validation set for this release is limited to: Segerstrom Center, Citizen Opera House, ASU Gammage, First Interstate Center for the Arts, Orpheum Theatre Minneapolis, Orpheum Theatre San Francisco, Paramount Theatre Seattle, and Aronoff Center.
- Excluded from the active validation set for this release: Grand Ole Opry, Broadway.com, and BroadwayDirect.com.

## Validation requirements
- Validate that the seat or seat block still exists for the target event.
- Validate section label, row label, seat label, and seat quality together.
- Validate the listing against live pricing conditions to ensure the ticket class remains equivalent.
- Validate that the same event is still active and not expired before accepting any listing.
- Validate freshness of the live snapshot before listing; stale inventory is not acceptable.

## Safety policy
- Never approve a listing based on a single stale or partial signal.
- Never approve inventory when equivalent seats are unavailable in the required 3X confidence model.
- Never rely on HTML snippets alone when seat count, price class, or section parity cannot be confirmed.
- Prefer rejecting, holding, or rechecking over false-positive approvals.

## Code quality expectations
- Keep the worker logic explicit and safety-driven.
- Favor structured inventory checks over loose text matching.
- Document venue-specific assumptions when a venue requires custom parsing rules.
- Prefer deterministic validation logic and explicit logging over ambiguous heuristics.

## Operational expectations
- Frequent revalidation is required during active monitoring hours because seat availability and pricing can change quickly.
- The system should prefer shorter polling intervals during the active window when demand is high.
- Any reset, exception, or off-hours skip must be logged clearly enough for operational review.
- The schedule should be intentionally non-predictable enough to avoid obvious bot signatures, while still preserving operational consistency and business-window enforcement.
- The system may use bounded randomization or jitter around a base interval to reduce scraping predictability without sacrificing coverage.

## Reference
This file supersedes generic project guidance in archived docs and should be treated as the authoritative working standard for this ticket-monitoring system.

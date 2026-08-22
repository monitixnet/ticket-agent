-- Verified from three SeatMe cart API samples across two Segerstrom
-- performances on 2026-08-22. SeatMe rounds the 18% fee per ticket to cents.
-- This is venue-scoped operational policy, not a cross-venue assumption.
UPDATE venue_runtime_configs
SET config_json = json_set(
  config_json,
  '$.checkoutFeeRule', json('{"type":"percentage_per_ticket","rateBasisPoints":1800,"rounding":"half_up","verifiedAt":"2026-08-22","evidence":"SeatMe cart API: 62.71->11.29, 79.66->14.34, 206.78->37.22"}')
)
WHERE venue_id = 'segerstrom_center';

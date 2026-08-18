export function parseSegerstromInventoryDocument(html = '', venueId = 'segerstrom_center') {
  try {
    const payload = JSON.parse(html || '{"seats":[],"prices":{}}');
    const seatInfoPayloads = payload.seats || [];
    const priceMap = payload.prices || {};
    const allSeats = [];

    // The payload is an array of responses from the seatinfo endpoint
    for (const seatInfo of seatInfoPayloads) {
      if (seatInfo && seatInfo.available) {
        for (const seatKey in seatInfo.available) {
          const seatData = seatInfo.available[seatKey];
          const priceCents = priceMap[seatData.zone] ? priceMap[seatData.zone] * 100 : null;
          allSeats.push(normalizeInventoryItem({
            venueId: venueId,
            section: seatInfo.sectionGroupName || seatData.custom?.web_text || 'Unknown',
            row: seatData.row,
            seat: seatData.num,
            priceLevel: seatData.zone, // Assuming zone is the price level
            priceCents: priceCents,
            seat_quality: 'standard', // Placeholder
            available: true,
          }));
        }
      }
    }
    return allSeats;
  } catch (e) {
    console.error('[PARSER - Segerstrom] Failed to parse inventory JSON.', e.message);
  }
  return [];
}

export const VENUE_PARSERS = {
  'segerstrom_center': parseSegerstromInventoryDocument
};

export function normalizePriceLevel(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "standard";

  if (/^(orch|orchestra|orchestra seat|orchestra row)$/.test(raw)) return "orch";
  if (/^(mezz|mezzanine|mez)$/.test(raw)) return "mezz";
  if (/^(balcony|balconi)$/i.test(raw)) return "balcony";
  if (/^(main|floor|front orchestra)$/.test(raw)) return "main";
  if (/^(premium|vip|club)$/.test(raw)) return "premium";

  return raw?.replace(/[^a-z0-9]+/g, "_")?.replace(/^_+|_+$/g, "") || "standard";
}

export function normalizeSeatQuality(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "standard";
  if (raw.includes("premium") || raw.includes("vip") || raw.includes("club")) return "premium";
  if (raw.includes("standard") || raw.includes("std")) return "standard";
  return raw?.replace(/[^a-z0-9]+/g, "_")?.replace(/^_+|_+$/g, "") || "standard";
}

export function normalizeLabel(value = "") {
  return String(value || "").trim()?.replace(/\s+/g, " ");
}

export function normalizeSectionLabel(value = "") {
  return normalizeLabel(value);
}

export function normalizeRowLabel(value = "") {
  return normalizeLabel(value);
}

export function normalizeSeatLabel(value = "") {
  return normalizeLabel(value);
}

export function normalizeInventoryItem(item = {}) {
  const rawQuantity = Number(item.quantity || item.qty || item.quantity_available || 1);
  const rawPriceCents = Number(item.priceCents ?? item.price_cents);

  return {
    venueId: String(item.venueId || item.venue_id || "").trim(),
    eventId: String(item.eventId || item.event_id || "").trim(),
    section: normalizeSectionLabel(item.section || item.section_label || ""),
    row: normalizeRowLabel(item.row || item.row_label || ""),
    seat: normalizeSeatLabel(item.seat || item.seat_label || ""),
    priceLevel: typeof item.priceLevel === 'number'
      ? item.priceLevel
      : normalizePriceLevel(item.priceLevel || item.price_level || "standard"),
    seatQuality: normalizeSeatQuality(item.seatQuality || item.seat_quality || "standard"),
    priceCents: Number.isFinite(rawPriceCents) ? rawPriceCents : null,
    quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1,
    available: item.available !== false
  };
}

export function isSpecificSeatMatch(candidateItem, targetListing = {}) {
  const candidate = normalizeInventoryItem(candidateItem);
  return candidate.section.toLowerCase() === normalizeSectionLabel(targetListing.section).toLowerCase()
    && candidate.row.toLowerCase() === normalizeRowLabel(targetListing.row).toLowerCase()
    && candidate.seat.toLowerCase() === normalizeSeatLabel(targetListing.seat).toLowerCase()
    && candidate.available;
}

export function isPriceParityMatch(candidateItem, targetListing = {}) {
  const candidate = normalizeInventoryItem(candidateItem);
  const targetPriceCents = Number(targetListing.priceCents);
  return Number.isFinite(targetPriceCents)
    && Number.isFinite(candidate.priceCents)
    && candidate.priceCents === targetPriceCents;
}

export function isEquivalentInventoryMatch(targetItem, candidateItem) {
  const target = normalizeInventoryItem(targetItem);
  const candidate = normalizeInventoryItem(candidateItem);

  return String(target.venueId).trim().toLowerCase() === String(candidate.venueId).trim().toLowerCase()
    && String(target.eventId).trim().toLowerCase() === String(candidate.eventId).trim().toLowerCase()
    && normalizeSectionLabel(target.section).toLowerCase() === normalizeSectionLabel(candidate.section).toLowerCase()
    && normalizePriceLevel(target.priceLevel) === normalizePriceLevel(candidate.priceLevel)
    && normalizeSeatQuality(target.seatQuality) === normalizeSeatQuality(candidate.seatQuality)
    && target.available
    && candidate.available;
}

export function evaluateEquivalentInventoryCoverage(targetSeat, inventory = []) {
  const target = normalizeInventoryItem(targetSeat);
  const quantity = Math.max(0, Number(target.quantity || 1));
  const matches = inventory
    .map(normalizeInventoryItem)
    .filter(candidate => isEquivalentInventoryMatch(target, candidate));

  const equivalentInventoryCount = matches.reduce((sum, candidate) => sum + Number(candidate.quantity || 1), 0);
  const requiredMinimum = quantity * 3;

  return {
    targetQuantity: quantity,
    equivalentInventoryCount,
    requiredMinimum,
    meetsRequirement: equivalentInventoryCount >= requiredMinimum,
    equivalentMatches: matches
  };
}

// A sellable multi-ticket recommendation must be one contiguous run in a
// single row. Blocks are deliberately non-overlapping so a nine-seat run does
// not masquerade as multiple independent six-seat backup options.
export function findContiguousSeatBlocks(targetPool, inventory = []) {
  const target = normalizeInventoryItem(targetPool);
  const quantity = Math.max(1, Number(target.quantity || 1));
  const byRow = new Map();
  for (const candidate of inventory.map(normalizeInventoryItem)) {
    if (!isEquivalentInventoryMatch(target, candidate)) continue;
    if (!/^\d+$/.test(String(candidate.seat))) continue;
    const row = String(candidate.row || '').trim();
    if (!row) continue;
    const seats = byRow.get(row) || [];
    seats.push(candidate);
    byRow.set(row, seats);
  }

  const blocks = [];
  for (const [row, rowSeats] of byRow) {
    const uniqueSeats = [...new Map(rowSeats.map(seat => [Number(seat.seat), seat])).values()]
      .sort((a, b) => Number(a.seat) - Number(b.seat));
    let run = [];
    const flushRun = () => {
      for (let index = 0; index + quantity <= run.length; index += quantity) {
        const seats = run.slice(index, index + quantity);
        blocks.push({ row, seats, startSeat: seats[0].seat, endSeat: seats.at(-1).seat });
      }
      run = [];
    };
    for (const seat of uniqueSeats) {
      if (run.length && Number(seat.seat) !== Number(run.at(-1).seat) + 1) flushRun();
      run.push(seat);
    }
    flushRun();
  }
  return blocks;
}

// Segerstrom-only confidence policy. A target block needs two more contiguous,
// non-overlapping blocks of the same quantity at the same price/quality pool.
// A backup may be in the target row (same quality) or a lower sort-order row
// (closer to the stage, therefore better). It never counts a row behind.
export function findSegerstromBufferedCandidates(inventory = [], quantity, rowOrdering = [], bufferBlockCount = 2) {
  const requiredBufferBlockCount = Math.max(1, Number(bufferBlockCount) || 2);
  const rowOrder = new Map(rowOrdering.map(row => [
    `${String(row.section_name || '').toLowerCase()}|${String(row.row_label || '').toLowerCase()}`,
    Number(row.sort_order)
  ]));
  const representatives = new Map();
  for (const item of inventory.map(normalizeInventoryItem)) {
    if (!item.available) continue;
    const key = [item.section, item.priceLevel, item.seatQuality]
      .map(value => String(value || '').trim().toLowerCase()).join('|');
    if (!representatives.has(key)) representatives.set(key, item);
  }

  const candidates = [];
  for (const targetPool of representatives.values()) {
    const blocks = findContiguousSeatBlocks({ ...targetPool, quantity }, inventory);
    for (const targetBlock of blocks) {
      const sectionKey = String(targetPool.section).trim().toLowerCase();
      const targetRowOrder = rowOrder.get(`${sectionKey}|${String(targetBlock.row).trim().toLowerCase()}`);
      if (!Number.isFinite(targetRowOrder)) continue; // fail closed when hall mapping is absent
      const bufferBlocks = blocks.filter(block => {
        if (block === targetBlock) return false;
        const candidateRowOrder = rowOrder.get(`${sectionKey}|${String(block.row).trim().toLowerCase()}`);
        return Number.isFinite(candidateRowOrder)
          && (candidateRowOrder === targetRowOrder || candidateRowOrder < targetRowOrder);
      });
      if (bufferBlocks.length < requiredBufferBlockCount) continue;
      candidates.push({
        targetQuantity: quantity,
        section: targetPool.section,
        row: targetBlock.row,
        startSeat: targetBlock.startSeat,
        endSeat: targetBlock.endSeat,
        priceLevel: targetPool.priceLevel,
        seatQuality: targetPool.seatQuality,
        priceCents: targetPool.priceCents,
        positionZone: 'not_applicable',
        targetSeats: targetBlock.seats.map(seat => seat.seat),
        bufferBlocks: bufferBlocks.slice(0, requiredBufferBlockCount).map(block => ({
          row: block.row,
          startSeat: block.startSeat,
          endSeat: block.endSeat,
          seats: block.seats.map(seat => seat.seat)
        }))
      });
    }
  }
  return candidates;
}

export function isNotApplicableRowPolicy(hallPolicy = {}) {
  return hallPolicy?.seatPositionPolicy === 'not_applicable_row_forward_only'
    && hallPolicy?.seatPositionZone === 'not_applicable';
}

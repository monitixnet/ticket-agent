// Checkout-fee rules are venue-scoped D1 policy. The Worker calculates only
// rules that have been explicitly verified for that venue; an invalid or
// missing rule fails closed and produces no estimated fee.
export function normalizeCheckoutFeeRule(rawRule) {
  if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) return null;
  if (rawRule.type !== 'percentage_per_ticket') return null;
  const rateBasisPoints = Number(rawRule.rateBasisPoints);
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) return null;
  return {
    type: 'percentage_per_ticket',
    rateBasisPoints,
    rounding: 'half_up',
    verifiedAt: typeof rawRule.verifiedAt === 'string' ? rawRule.verifiedAt : null,
    evidence: typeof rawRule.evidence === 'string' ? rawRule.evidence : null
  };
}

export function calculateCandidateCheckoutAmounts(priceCents, quantity, rawRule) {
  const rule = normalizeCheckoutFeeRule(rawRule);
  const unitPriceCents = Number(priceCents);
  const targetQuantity = Number(quantity);
  if (!rule || !Number.isInteger(unitPriceCents) || unitPriceCents < 0
    || !Number.isInteger(targetQuantity) || targetQuantity < 1) return null;

  // Prices and basis points are integers. Math.round is half-up for the
  // non-negative currency amounts accepted above, matching the observed
  // SeatMe per-ticket rounding behavior.
  const feePerTicketCents = Math.round((unitPriceCents * rule.rateBasisPoints) / 10000);
  const allInPerTicketCents = unitPriceCents + feePerTicketCents;
  return {
    rule,
    unitPriceCents,
    feePerTicketCents,
    allInPerTicketCents,
    ticketSubtotalCents: unitPriceCents * targetQuantity,
    feeTotalCents: feePerTicketCents * targetQuantity,
    allInTotalCents: allInPerTicketCents * targetQuantity
  };
}

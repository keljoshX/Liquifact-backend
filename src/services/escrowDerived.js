'use strict';

/**
 * @fileoverview Pure computation functions for escrow derived display fields.
 *
 * Three fields are derived server-side so the UI receives ready-to-render values:
 *   apyPercent      — Annual yield rate rounded to 2 dp.
 *   fundedPercent   — Portion of invoice face value currently in escrow (0–100+).
 *   daysToMaturity  — Whole days until maturity; negative means overdue.
 *
 * Ledger-time assumption: daysToMaturity is computed against server wall clock
 * (Date.now()), NOT Stellar ledger time. Stellar ledgers close in ~5 s, so the
 * delta is negligible for day-level precision. Inject `opts.now` to override.
 *
 * APY assumption: annualRatePercent is treated as a simple annual rate (no
 * compounding). Invoice-discounting products use simple interest conventions.
 *
 * Rounding: all percent values use Math.round(x * 100) / 100 (round-half-up
 * at 2 dp) to avoid IEEE 754 drift in UI rendering.
 *
 * @module services/escrowDerived
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Computes APY from a simple annual rate.
 *
 * @param {unknown} annualRatePercent - e.g. 8.5 for 8.5 %.
 * @returns {number|null} Rounded to 2 dp, or null on bad input.
 */
function computeApyPercent(annualRatePercent) {
  if (
    typeof annualRatePercent !== 'number' ||
    !isFinite(annualRatePercent) ||
    annualRatePercent < 0
  ) {
    return null;
  }
  return Math.round(annualRatePercent * 100) / 100;
}

/**
 * Computes funded percent: (fundedAmount / totalAmount) * 100, rounded to 2 dp.
 * Returns null when totalAmount is zero/negative or either value is non-numeric.
 *
 * @param {unknown} fundedAmount - Amount currently held in escrow.
 * @param {unknown} totalAmount  - Invoice face value (denominator).
 * @returns {number|null}
 */
function computeFundedPercent(fundedAmount, totalAmount) {
  if (
    typeof fundedAmount !== 'number' ||
    !isFinite(fundedAmount) ||
    typeof totalAmount !== 'number' ||
    !isFinite(totalAmount) ||
    totalAmount <= 0
  ) {
    return null;
  }
  return Math.round((fundedAmount / totalAmount) * 10000) / 100;
}

/**
 * Computes whole days from `now` to `maturityDate`. Uses Math.floor so a
 * maturity later the same day returns 0. Negative values indicate overdue.
 *
 * @param {Date|string|number|null|undefined} maturityDate
 * @param {Date} [now=new Date()]
 * @returns {number|null} Null when maturityDate is absent or unparseable.
 */
function computeDaysToMaturity(maturityDate, now = new Date()) {
  if (maturityDate == null) return null;
  const maturity =
    maturityDate instanceof Date ? maturityDate : new Date(maturityDate);
  if (isNaN(maturity.getTime())) return null;
  const nowMs = (now instanceof Date ? now : new Date()).getTime();
  return Math.floor((maturity.getTime() - nowMs) / MS_PER_DAY);
}

/**
 * Derives display fields from a raw escrow state object.
 *
 * Source fields consumed from `state`:
 *   fundedAmount      {number}             — Amount currently held.
 *   totalAmount       {number}             — Invoice face value.
 *   annualRatePercent {number}             — Simple annual yield in % (e.g. 8.5).
 *   maturityDate      {Date|string|number} — Maturity timestamp.
 *   maturityTimestamp {Date|string|number} — Alias for maturityDate; ignored when
 *                                            maturityDate is present.
 *
 * All output fields default to null when their source data is absent or invalid.
 *
 * @param {object} state        - Raw escrow state.
 * @param {object} [opts={}]
 * @param {Date}   [opts.now]   - Reference time for daysToMaturity; defaults to
 *                                `new Date()`.
 * @returns {{ apyPercent: number|null, fundedPercent: number|null, daysToMaturity: number|null }}
 */
function computeEscrowDerivedFields(state, opts = {}) {
  const { now = new Date() } = opts;
  const { fundedAmount, totalAmount, annualRatePercent, maturityDate, maturityTimestamp } =
    state;

  const maturity = maturityDate != null ? maturityDate : (maturityTimestamp != null ? maturityTimestamp : null);

  return {
    apyPercent: computeApyPercent(annualRatePercent),
    fundedPercent: computeFundedPercent(fundedAmount, totalAmount),
    daysToMaturity: computeDaysToMaturity(maturity, now),
  };
}

module.exports = {
  computeApyPercent,
  computeFundedPercent,
  computeDaysToMaturity,
  computeEscrowDerivedFields,
};

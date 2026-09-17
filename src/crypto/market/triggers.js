function safeRatio(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) return 0;
  return value / baseline;
}

export function evaluatePreliminaryTrigger(metrics, baseline) {
  const spreadFloor = Math.max(0, Number(metrics.spreadPct ?? baseline.medianSpreadPct ?? 0) * 4);
  const floor5m = Math.max(0.35, spreadFloor, 3 * Number(baseline.medianAbsReturn5mPct || 0));
  const floor15m = Math.max(0.8, spreadFloor, 3 * Number(baseline.medianAbsReturn15mPct || 0));
  const floor1h = Math.max(1.2, spreadFloor, 3 * Number(baseline.medianAbsReturn1hPct || 0));
  const floor2h = Math.max(1.8, spreadFloor, 3 * Number(baseline.medianAbsReturn2hPct || 0));
  const floor4h = Math.max(2.5, spreadFloor, 3 * Number(baseline.medianAbsReturn4hPct || 0));
  const return5m = Math.abs(Number(metrics.return5mPct || 0));
  const return15m = Math.abs(Number(metrics.return15mPct || 0));
  const return1h = Math.abs(Number(metrics.return1hPct || metrics.return60mPct || 0));
  const return2h = Math.abs(Number(metrics.return2hPct || 0));
  const return4h = Math.abs(Number(metrics.return4hPct || 0));
  const priceSurprise5m = safeRatio(return5m, baseline.medianAbsReturn5mPct);
  const priceSurprise15m = safeRatio(return15m, baseline.medianAbsReturn15mPct);
  const priceSurprise1h = safeRatio(return1h, baseline.medianAbsReturn1hPct);
  const priceSurprise2h = safeRatio(return2h, baseline.medianAbsReturn2hPct);
  const priceSurprise4h = safeRatio(return4h, baseline.medianAbsReturn4hPct);
  const volume5mRatio = safeRatio(metrics.volume5mUsd, baseline.medianVolume5mUsd);
  const volume15mRatio = safeRatio(metrics.volume15mUsd, baseline.medianVolume15mUsd);
  const liquidationRatio = safeRatio(metrics.liquidationUsd, baseline.medianLiquidationUsd);
  const reasons = [];
  if (return5m >= floor5m) reasons.push('price_5m');
  if (return15m >= floor15m) reasons.push('price_15m');
  if (return1h >= floor1h && priceSurprise1h >= 1.5) reasons.push('price_1h');
  if (return2h >= floor2h && priceSurprise2h >= 1.5) reasons.push('price_2h');
  if (return4h >= floor4h && priceSurprise4h >= 1.5) reasons.push('price_4h');
  if (volume5mRatio >= 4 && priceSurprise5m >= 1.5) reasons.push('volume_5m');
  if (volume15mRatio >= 3 && priceSurprise15m >= 1.5) reasons.push('volume_15m');
  if (liquidationRatio >= 4 && Math.max(priceSurprise5m, priceSurprise15m) >= 1.5) reasons.push('liquidation');
  const mediumSignals = [
    Math.max(priceSurprise5m, priceSurprise15m, priceSurprise1h, priceSurprise2h, priceSurprise4h) >= 1.5,
    Math.max(volume5mRatio, volume15mRatio) >= 3,
    liquidationRatio >= 4,
  ].filter(Boolean).length;
  if (mediumSignals >= 2 && reasons.length === 0) reasons.push('compound_anomaly');
  if (mediumSignals >= 2 && !reasons.some((reason) => reason.startsWith('price_'))) reasons.push('compound_anomaly');
  return {
    triggered: reasons.length > 0,
    reasons: [...new Set(reasons)],
    floors: { return5mPct: floor5m, return15mPct: floor15m, return1hPct: floor1h, return2hPct: floor2h, return4hPct: floor4h },
    ratios: { priceSurprise5m, priceSurprise15m, priceSurprise1h, priceSurprise2h, priceSurprise4h, volume5mRatio, volume15mRatio, liquidationRatio },
  };
}

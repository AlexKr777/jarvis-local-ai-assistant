function bounded(value, limit) {
  return Math.max(-limit, Math.min(limit, Math.round(value * 1_000) / 1_000));
}

function groupedWeights(outcomes, key, limit) {
  const groups = new Map();
  for (const outcome of outcomes) {
    const name = outcome[key];
    if (!name) continue;
    const values = groups.get(name) || [];
    values.push((outcome.directionCorrect ? 1 : -1) + Math.min(1, Number(outcome.engagementRate || 0) * 20));
    groups.set(name, values);
  }
  return Object.fromEntries([...groups].map(([name, values]) => {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return [name, bounded(average >= 0 ? limit : -limit, limit)];
  }));
}

export function updateLearningProfile(previous = {}, outcomes = []) {
  const samples = outcomes.length;
  if (samples < 8) return { samples, adjustments: {} };
  const adjustments = {
    presetWeights: groupedWeights(outcomes, 'preset', 0.05),
  };
  if (samples >= 15) {
    const accuracy = outcomes.filter((outcome) => outcome.directionCorrect).length / samples;
    adjustments.editorialThresholdDelta = accuracy < 0.55 ? 2 : accuracy > 0.75 ? -1 : 0;
  }
  if (samples >= 30) adjustments.hookWeights = groupedWeights(outcomes, 'hookFamily', 0.1);
  return { samples, adjustments };
}

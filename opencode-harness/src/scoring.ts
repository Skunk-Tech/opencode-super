export type CandidateScore = {
  frequency: number;
  cost: number;
  risk: number;
  stability: number;
  covered: number;
};

const WEIGHTS = { frequency: 0.3, cost: 0.2, risk: 0.15, stability: 0.2, uncovered: 0.15 };
const THRESHOLD = 0.6;

export function scoreCandidate(c: CandidateScore): number {
  const raw = c.frequency * WEIGHTS.frequency + c.cost * WEIGHTS.cost + c.risk * WEIGHTS.risk + c.stability * WEIGHTS.stability + (1 - c.covered) * WEIGHTS.uncovered;
  return Math.min(1, Math.max(0, raw));
}

export function shouldRecommend(score: number): boolean {
  return score >= THRESHOLD;
}

export function scoreLabel(score: number): "strong" | "moderate" | "weak" {
  if (score >= 0.8) return "strong";
  if (score >= THRESHOLD) return "moderate";
  return "weak";
}

import { expect, test } from "bun:test";
import { scoreCandidate, shouldRecommend, scoreLabel } from "../src/scoring";

test("high-frequency, costly, uncovered candidate scores strong", () => {
  const s = scoreCandidate({ frequency: 0.9, cost: 0.8, risk: 0.6, stability: 0.9, covered: 0 });
  expect(s).toBeGreaterThanOrEqual(0.6);
  expect(shouldRecommend(s)).toBe(true);
  expect(scoreLabel(s)).toBe("strong");
});

test("isolated one-off candidate scores weak", () => {
  const s = scoreCandidate({ frequency: 0.1, cost: 0.2, risk: 0.1, stability: 0.3, covered: 0.5 });
  expect(s).toBeLessThan(0.6);
  expect(shouldRecommend(s)).toBe(false);
  expect(scoreLabel(s)).toBe("weak");
});

test("mid-range candidate scores moderate and is recommended", () => {
  // 0.7*0.3 + 0.7*0.2 + 0.5*0.15 + 0.7*0.2 + (1-0)*0.15 = 0.21+0.14+0.075+0.14+0.15 = 0.715
  const s = scoreCandidate({ frequency: 0.7, cost: 0.7, risk: 0.5, stability: 0.7, covered: 0 });
  expect(s).toBeCloseTo(0.715);
  expect(shouldRecommend(s)).toBe(true);
  expect(scoreLabel(s)).toBe("moderate");
});

test("score boundaries at 0.6 and 0.8", () => {
  expect(shouldRecommend(0.6)).toBe(true);
  expect(scoreLabel(0.6)).toBe("moderate");
  expect(shouldRecommend(0.8)).toBe(true);
  expect(scoreLabel(0.8)).toBe("strong");
  expect(scoreLabel(0.79)).toBe("moderate");
  expect(scoreLabel(0.59)).toBe("weak");
  expect(shouldRecommend(0.59)).toBe(false);
});

import { describe, it, expect } from "vitest";
import {
  shouldReplan,
  isNoOpDiff,
  truncateDiff,
  ADAPTIVE_DEFAULTS,
  type EvaluationResult,
  type AdaptiveResolvedConfig,
} from "../../src/lib/AdaptiveDriver.js";

describe("shouldReplan", () => {
  const baseCfg: AdaptiveResolvedConfig = { confidenceThreshold: 0.7, maxReplans: 3, diffMaxBytes: 1024 };
  const baseEval = (over: Partial<EvaluationResult> = {}): EvaluationResult => ({
    planStillValid: true,
    surprises: [],
    confidence: 0.95,
    notes: "",
    ...over,
  });

  it("returns below-threshold when plan valid, high confidence, no surprises", () => {
    const out = shouldReplan(baseEval(), { replansUsed: 0, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: false, reason: "below-threshold" });
  });

  it("returns run=true when plan declared invalid", () => {
    const out = shouldReplan(
      baseEval({ planStillValid: false }),
      { replansUsed: 0, lastReplanWasNoOp: false },
      baseCfg,
    );
    expect(out).toEqual({ run: true });
  });

  it("returns run=true when confidence below threshold", () => {
    const out = shouldReplan(
      baseEval({ confidence: 0.5 }),
      { replansUsed: 0, lastReplanWasNoOp: false },
      baseCfg,
    );
    expect(out).toEqual({ run: true });
  });

  it("returns run=true when surprises non-empty", () => {
    const out = shouldReplan(
      baseEval({ surprises: ["x"] }),
      { replansUsed: 0, lastReplanWasNoOp: false },
      baseCfg,
    );
    expect(out).toEqual({ run: true });
  });

  it("returns budget-exhausted when replansUsed == maxReplans", () => {
    const out = shouldReplan(
      baseEval({ surprises: ["x"] }),
      { replansUsed: 3, lastReplanWasNoOp: false },
      baseCfg,
    );
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });

  it("returns budget-exhausted when replansUsed > maxReplans", () => {
    const out = shouldReplan(
      baseEval({ surprises: ["x"] }),
      { replansUsed: 4, lastReplanWasNoOp: false },
      baseCfg,
    );
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });

  it("returns convergence when lastReplanWasNoOp even if surprises present", () => {
    const out = shouldReplan(
      baseEval({ surprises: ["x"] }),
      { replansUsed: 0, lastReplanWasNoOp: true },
      baseCfg,
    );
    expect(out).toEqual({ run: false, reason: "convergence" });
  });

  it("budget exhaustion precedes convergence precedes threshold", () => {
    // Both lastReplanWasNoOp and budget exhausted → budget-exhausted reported first
    const out = shouldReplan(
      baseEval({ surprises: ["x"] }),
      { replansUsed: 3, lastReplanWasNoOp: true },
      baseCfg,
    );
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });
});

describe("isNoOpDiff", () => {
  it("returns true for structurally identical task arrays", () => {
    expect(isNoOpDiff([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "b" }])).toBe(true);
  });

  it("returns false when task order changes", () => {
    expect(isNoOpDiff([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }])).toBe(false);
  });

  it("returns false when a task is added", () => {
    expect(isNoOpDiff([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(false);
  });

  it("returns false when a field changes", () => {
    expect(isNoOpDiff([{ id: "a", title: "x" }], [{ id: "a", title: "y" }])).toBe(false);
  });

  it("returns true for two empty arrays", () => {
    expect(isNoOpDiff([], [])).toBe(true);
  });
});

describe("truncateDiff", () => {
  it("returns full patch untouched when under limit", () => {
    const out = truncateDiff("abc", ["f1"], 100);
    expect(out.truncated).toBe(false);
    expect(out.patch).toBe("abc");
    expect(out.fullSizeBytes).toBe(3);
    expect(out.filesChanged).toEqual(["f1"]);
  });

  it("returns exact patch when size equals limit", () => {
    const out = truncateDiff("abcd", ["f1"], 4);
    expect(out.truncated).toBe(false);
    expect(out.patch).toBe("abcd");
  });

  it("truncates and sets truncated flag when over limit", () => {
    const out = truncateDiff("abcdefghij", ["f1", "f2"], 4);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.patch, "utf8")).toBeLessThanOrEqual(4);
    expect(out.fullSizeBytes).toBe(10);
    expect(out.filesChanged).toEqual(["f1", "f2"]);
  });

  it("preserves full filesChanged list even when patch truncated", () => {
    const patch = "x".repeat(1000);
    const files = ["a.ts", "b.ts", "c.ts"];
    const out = truncateDiff(patch, files, 10);
    expect(out.filesChanged).toEqual(files);
    expect(out.truncated).toBe(true);
  });
});

describe("ADAPTIVE_DEFAULTS", () => {
  it("exports the documented defaults", () => {
    expect(ADAPTIVE_DEFAULTS).toEqual({ confidenceThreshold: 0.7, maxReplans: 5, diffMaxBytes: 32768 });
  });
});

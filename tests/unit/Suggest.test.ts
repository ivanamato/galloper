import { describe, it, expect } from "vitest";
import { nearest } from "../../src/lib/Suggest.js";

describe("nearest", () => {
  it("returns empty array for exact match in candidates", () => {
    const result = nearest("plan", ["plan", "implement", "single-prompt"]);
    expect(result).toEqual([]);
  });

  it("suggests plan for single-char typo plna", () => {
    const result = nearest("plna", ["plan", "implement", "single-prompt"]);
    expect(result[0]).toBe("plan");
  });

  it("suggests plan for transposition paln", () => {
    const result = nearest("paln", ["plan", "implement", "single-prompt"]);
    expect(result[0]).toBe("plan");
  });

  it("returns empty array for unrelated input", () => {
    const result = nearest("zzzzzzzz", ["plan", "implement", "single-prompt"]);
    expect(result).toEqual([]);
  });

  it("orders multiple near matches by distance", () => {
    const result = nearest("pln", ["plan", "plant", "plane"]);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe("plan");
  });

  it("respects max parameter cap", () => {
    const candidates = ["plan", "plane", "plant", "plain"];
    const result = nearest("pln", candidates, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array for empty candidates", () => {
    const result = nearest("anything", []);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    const result = nearest("", ["plan", "implement"]);
    expect(result).toEqual([]);
  });

  it("handles unicode input without crashing", () => {
    const result = nearest("plán", ["plan", "implement"]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles unicode candidates without crashing", () => {
    const result = nearest("plan", ["plán", "implementó"]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("suggests nearest when close enough", () => {
    const result = nearest("implemen", ["implement", "plan"]);
    expect(result[0]).toBe("implement");
  });

  it("does not suggest when distance is too large", () => {
    const result = nearest("xyz", ["abcdefghijk"]);
    expect(result).toEqual([]);
  });
});

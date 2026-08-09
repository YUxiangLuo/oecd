import { describe, expect, test } from "bun:test";
import { quizTeachingNote } from "./step-quiz";

describe("quiz prerequisite copy", () => {
  test("defines the centered baseline before the step 13 interaction question", () => {
    const note = quizTeachingNote(13);
    expect(note).toContain("中心化水平");
    expect(note).toContain("减去样本个体均值");
  });

  test("does not add unrelated boilerplate to other quizzes", () => {
    expect(quizTeachingNote(12)).toBeNull();
    expect(quizTeachingNote(15)).toBeNull();
  });
});

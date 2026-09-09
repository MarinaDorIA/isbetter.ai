import { describe, expect, it } from "vitest";
import { deepEqual, extractAnswer, grade, parseSuite, suiteToJSON } from "./bench-core";

describe("parseSuite", () => {
  it("takes a bare array, an object, and the field aliases", () => {
    expect(parseSuite('[{"q":"2+2","a":"4"}]')).toEqual({
      name: "Benchmark",
      lang: "text",
      cases: [{ q: "2+2", a: "4" }],
    });
    expect(
      parseSuite('{"name":"Geo","cases":[{"question":"Capital?","expected":["Paris","París"]}]}'),
    ).toEqual({
      name: "Geo",
      lang: "text",
      cases: [{ q: "Capital?", a: ["Paris", "París"] }],
    });
  });

  it("rejects a suite it cannot run", () => {
    expect(() => parseSuite('{"cases":[]}')).toThrow();
    expect(() => parseSuite('[{"a":"4"}]')).toThrow();
    expect(() => parseSuite("nope")).toThrow();
  });
});

describe("extractAnswer", () => {
  it("digs the answer out of whatever the model returned", () => {
    expect(extractAnswer('{"answer":"Paris"}')).toBe("Paris");
    expect(extractAnswer('```json\n{"answer": 42}\n```')).toBe("42");
    expect(extractAnswer('Sure! {"answer":"Paris"} hope that helps')).toBe("Paris");
    expect(extractAnswer("Paris")).toBe("Paris");
  });
});

describe("grade", () => {
  it("ignores case, accents and trailing punctuation", () => {
    expect(grade("París", "paris.")).toBe(true);
    expect(grade("Paris", '"Paris"')).toBe(true);
    expect(grade(["si", "yes"], "YES")).toBe(true);
  });

  it("compares numbers by value", () => {
    expect(grade("4", "4.0")).toBe(true);
    expect(grade("3.5", "3,5")).toBe(true);
    expect(grade("4", "5")).toBe(false);
  });

  it("fails a wrong or empty answer", () => {
    expect(grade("Paris", "Madrid")).toBe(false);
    expect(grade("Paris", "")).toBe(false);
    expect(grade("", "anything")).toBe(false);
  });
});

describe("code suites", () => {
  const raw = `{"name":"Kata","lang":"js","entry":"add","task":"Add two numbers",
    "cases":[{"in":[1,2],"out":3},{"in":[[1,2]],"out":[1,2]}]}`;

  it("keeps arguments and expected values as JSON text", () => {
    const suite = parseSuite(raw);
    expect(suite.lang).toBe("js");
    expect(suite.entry).toBe("add");
    expect(suite.task).toBe("Add two numbers");
    expect(suite.cases).toEqual([
      { q: "[1,2]", a: "3" },
      { q: "[[1,2]]", a: "[1,2]" },
    ]);
  });

  it("round-trips through export", () => {
    expect(parseSuite(suiteToJSON(parseSuite(raw)))).toEqual(parseSuite(raw));
  });

  it("rejects a case with no arguments", () => {
    expect(() => parseSuite('{"lang":"js","cases":[{"out":3}]}')).toThrow();
  });
});

describe("deepEqual", () => {
  it("compares structures, not references", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(0.1 + 0.2, 0.3)).toBe(true); // float tolerance
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/domain/quote/canonical";
import { sha256Hex } from "@/lib/hash";

describe("canonicalJson", () => {
  it("sorts object keys and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("gives the same text whatever the insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2, z: 3 })).toBe(canonicalJson({ z: 3, y: 2, x: 1 }));
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sorts keys by code point, not by UTF-16 unit", () => {
    // U+FF5E is one unit (0xFF5E); U+1F600 is a surrogate pair (0xD83D...). By code point U+FF5E < U+1F600,
    // by UTF-16 unit the emoji would come first.
    expect(canonicalJson({ "\u{1F600}": 1, "～": 2 })).toBe('{"～":2,"\u{1F600}":1}');
  });

  it("encodes strings, null and booleans like JSON", () => {
    expect(canonicalJson({ s: 'a"b\n', n: null, t: true, f: false })).toBe('{"f":false,"n":null,"s":"a\\"b\\n","t":true}');
  });

  it("accepts safe integers including zero and negatives", () => {
    expect(canonicalJson([0, -5, 108000])).toBe("[0,-5,108000]");
  });

  it.each([
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative zero", -0],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["undefined", undefined],
    ["a bigint", BigInt(1)],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
  ])("throws on %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("throws on an object property that is undefined", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });

  it("throws on a circular structure", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow();
  });
});

describe("sha256Hex", () => {
  it("matches the published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the UTF-8 bytes", () => {
    expect(sha256Hex("é")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
  });
});

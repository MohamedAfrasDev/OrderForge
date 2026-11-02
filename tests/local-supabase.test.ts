import { describe, expect, it } from "vitest";
import { explainStatusFailure, parseStatusOutput } from "./support/local-supabase";

describe("explainStatusFailure", () => {
  it("says the CLI is too old when it cannot parse this repo's config.toml", () => {
    const stderr =
      "failed to parse config: decoding failed due to the following error(s):\n'db' has invalid keys: orioledb_version\n";
    const message = explainStatusFailure(stderr);
    expect(message).toMatch(/too old/i);
    expect(message).toContain("2.119");
    expect(message).toContain("supabase --version");
    // It points at the usual causes: a second, older install on PATH, or one in a parent folder's node_modules/.bin.
    expect(message).toMatch(/where supabase|second|another/i);
    expect(message).toMatch(/parent/i);
    expect(message).toMatch(/node_modules/);
  });

  it("recognises other invalid-key errors from an outdated CLI too", () => {
    expect(explainStatusFailure("'db.migrations' has invalid keys: enabled")).toMatch(/too old/i);
  });

  it("says Docker is not running", () => {
    const stderr = "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine";
    expect(explainStatusFailure(stderr)).toMatch(/docker/i);
    expect(explainStatusFailure(stderr)).toMatch(/not running|start/i);
  });

  it("says to run supabase start when the stack simply is not up", () => {
    const message = explainStatusFailure("supabase start is not running.");
    expect(message).toContain("supabase start");
  });

  it("always includes the CLI's own first line, so nothing is hidden", () => {
    expect(explainStatusFailure("something unexpected happened\nmore detail")).toContain("something unexpected happened");
  });

  it("copes with empty output", () => {
    expect(explainStatusFailure("")).toContain("supabase start");
  });
});

describe("parseStatusOutput", () => {
  const json = JSON.stringify({ API_URL: "http://127.0.0.1:54321", ANON_KEY: "anon", SERVICE_ROLE_KEY: "service" });

  it("reads the keys, ignoring any text before the JSON", () => {
    expect(parseStatusOutput(`Stopped services: [x y]\n${json}`)).toEqual({
      ok: true,
      url: "http://127.0.0.1:54321",
      anonKey: "anon",
      serviceKey: "service",
    });
  });

  it("refuses anything that is not a local address, so tests can never touch a hosted project", () => {
    const hosted = JSON.stringify({ API_URL: "https://abc.supabase.co", ANON_KEY: "a", SERVICE_ROLE_KEY: "s" });
    const result = parseStatusOutput(hosted);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/non-local|not local/i);
  });

  it("fails clearly on output that is not JSON or lacks keys", () => {
    expect(parseStatusOutput("nothing useful").ok).toBe(false);
    expect(parseStatusOutput(JSON.stringify({ API_URL: "http://127.0.0.1:54321" })).ok).toBe(false);
  });
});

// Finds the LOCAL Supabase stack for the database tests and the E2E suite, and says plainly why it cannot.
// Credentials come from `supabase status`, never from .env, and anything that is not a local address is refused,
// so these tests can never touch a hosted project.
import { execSync } from "node:child_process";

/** The oldest Supabase CLI that can read this repo's supabase/config.toml (it was written by this version). */
export const MIN_SUPABASE_CLI = "2.119";

export type LocalSupabase =
  | { ok: true; url: string; anonKey: string; serviceKey: string }
  | { ok: false; reason: string };

/** Turns the CLI's stderr into one sentence a person can act on. The CLI's own first line is always included. */
export function explainStatusFailure(stderr: string): string {
  const firstLine = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const cli = firstLine ? ` (CLI said: ${firstLine.slice(0, 160)})` : "";

  if (/failed to parse config|invalid keys/i.test(stderr)) {
    return (
      `The Supabase CLI on PATH is too old to read this repo's supabase/config.toml: it needs ${MIN_SUPABASE_CLI} or newer. ` +
      "Run `supabase --version`, then look for a second, older install: earlier on PATH (on Windows `where supabase`; " +
      "an npm-global install often shadows Scoop's), or in the `node_modules/.bin` of a parent folder of this project " +
      "(npm puts those on PATH too, so a stray install in your home folder wins)." +
      cli
    );
  }
  if (/docker/i.test(stderr)) {
    return `Docker is not running. Start Docker, then run \`supabase start\`.${cli}`;
  }
  return `Local Supabase is not running. Start it with \`supabase start\`.${cli}`;
}

/** Reads the keys out of `supabase status -o json` output (which may have text before the JSON). */
export function parseStatusOutput(raw: string): LocalSupabase {
  let json: { API_URL?: string; ANON_KEY?: string; SERVICE_ROLE_KEY?: string };
  try {
    json = JSON.parse(raw.slice(raw.indexOf("{")));
  } catch {
    return { ok: false, reason: "`supabase status -o json` did not return JSON." };
  }
  if (!json.API_URL || !json.ANON_KEY || !json.SERVICE_ROLE_KEY) {
    return { ok: false, reason: "`supabase status` did not report the API URL and keys: is the stack fully started?" };
  }
  const host = new URL(json.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    return { ok: false, reason: `Refusing to use a non-local Supabase host (${host}); these tests only run against the local stack.` };
  }
  return { ok: true, url: json.API_URL, anonKey: json.ANON_KEY, serviceKey: json.SERVICE_ROLE_KEY };
}

let cached: LocalSupabase | undefined;

/** Runs `supabase status` once per process. */
export function readLocalSupabase(): LocalSupabase {
  if (cached) return cached;
  try {
    const raw = execSync("supabase status -o json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    cached = parseStatusOutput(raw);
  } catch (error) {
    cached = { ok: false, reason: explainStatusFailure(String((error as { stderr?: unknown }).stderr ?? "")) };
  }
  return cached;
}

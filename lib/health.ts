export type HealthDeps = {
  checkEnv: () => boolean;
  checkDatabase: () => Promise<boolean>;
};

type Check = "ok" | "fail" | "skipped";

/**
 * Liveness plus a look at the two things the app cannot run without. Output is deliberately
 * coarse: no variable names, hosts, versions or error text.
 */
export async function handleHealth(deps: HealthDeps): Promise<Response> {
  const env: Check = deps.checkEnv() ? "ok" : "fail";

  let database: Check = "skipped";
  if (env === "ok") {
    try {
      database = (await deps.checkDatabase()) ? "ok" : "fail";
    } catch {
      database = "fail";
    }
  }

  const healthy = env === "ok" && database === "ok";
  return Response.json(
    { status: healthy ? "ok" : "degraded", sandbox: true, checks: { env, database } },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

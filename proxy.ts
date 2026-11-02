import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { verifyCustomerLink } from "@/lib/access/customer-link";
import { getClientEnv } from "@/lib/env-client";
import { parseAccessLinkSecret } from "@/lib/env-schema";
import { createRateLimiter } from "@/lib/rate-limit";

// Two jobs, both coarse (see lib/access/* for the real authorization checks):
//  1. /merchant: refresh the Supabase session and send visitors without one to the login page.
//  2. /o and /store: rate limit by client address, and keep customer links out of caches and Referer headers.

// Module state lives per server instance: a brake on link guessing and spam, not a precise quota.
const limiters = {
  order: createRateLimiter({ limit: 60, windowMs: 60_000 }),
  store: createRateLimiter({ limit: 30, windowMs: 60_000 }),
};

/** Behind Vercel the platform sets x-forwarded-for, so a caller cannot choose their own address. */
function clientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(request: NextRequest, limiter: keyof typeof limiters): NextResponse | null {
  const result = limiters[limiter].check(clientKey(request));
  if (result.allowed) return null;
  return new NextResponse("Too many requests. Please wait a moment and try again.", {
    status: 429,
    headers: { "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" },
  });
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (path.startsWith("/o/")) {
    const limited = rateLimited(request, "order");
    if (limited) return limited;
    // Forged, expired and malformed links get a real 404 here, without touching the database.
    // Revocation and unknown inquiries need the database and are decided in the page.
    if (!hasValidLinkSignature(path.slice("/o/".length))) {
      return NextResponse.rewrite(new URL("/_not-found", request.url), {
        status: 404,
        headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
      });
    }
    const response = NextResponse.next();
    // The token in the URL is a credential.
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  if (path.startsWith("/store/")) {
    return rateLimited(request, "store") ?? NextResponse.next();
  }

  return merchantGate(request);
}

function hasValidLinkSignature(token: string): boolean {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
  return verifyCustomerLink(token, { secret: parseAccessLinkSecret(process.env) }).ok;
}

async function merchantGate(request: NextRequest) {
  const env = getClientEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Responses that set auth cookies must never be cached.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const isLoginPage = request.nextUrl.pathname === "/merchant/login";

  if (!data.user && !isLoginPage) {
    return NextResponse.redirect(new URL("/merchant/login", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/merchant", "/merchant/:path*", "/o/:path*", "/store/:path*"],
};

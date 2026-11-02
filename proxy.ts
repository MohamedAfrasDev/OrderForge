import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getClientEnv } from "@/lib/env-client";

// Coarse gate for /merchant: refresh the Supabase session and send visitors without one to
// the login page. This is NOT the authorization check; every page and action still calls
// requireMerchant() (lib/access/require-merchant.ts).
export async function proxy(request: NextRequest) {
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
  matcher: ["/merchant", "/merchant/:path*"],
};

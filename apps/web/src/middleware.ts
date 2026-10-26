import { NextResponse, type NextRequest } from "next/server";

/** Fast redirect for signed-out visitors. The API remains the authority on session validity. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get("orbix_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/app/:path*", "/onboarding"] };

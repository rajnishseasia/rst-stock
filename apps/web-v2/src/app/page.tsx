"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { useSession } from "@/lib/auth-client";

export default function Page() {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  // If the visitor already has a valid session cookie, skip the marketing
  // landing page and drop them straight into the trading dashboard. Better
  // Auth's useSession hits /api/auth/get-session, so cookie-based auth
  // (Google OAuth, etc.) is detected automatically - no manual cookie
  // parsing needed.
  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace("/app");
    }
  }, [isPending, session, router]);

  // While we know the user is signed in, render nothing so the landing-page
  // scroll choreography doesn't flash for a frame before the redirect.
  if (!isPending && session?.user) {
    return null;
  }

  return <LandingPage />;
}

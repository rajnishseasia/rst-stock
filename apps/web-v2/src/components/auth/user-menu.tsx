"use client";

import { useState } from "react";
import { useSession, signInWithGoogle, handleSignOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";

export function UserMenu() {
  const { data: session, isPending } = useSession();
  const [avatarError, setAvatarError] = useState(false);

  if (isPending) {
    return (
      <div className="h-9 w-20 animate-pulse bg-muted rounded-md" />
    );
  }

  if (!session?.user) {
    return (
      <Button
        onClick={() => signInWithGoogle()}
        variant="default"
        aria-label="Sign in with Google"
        className="min-h-11 min-w-11 px-3 sm:min-h-0 sm:min-w-0"
      >
        <span className="sm:hidden">Sign in</span>
        <span className="hidden sm:inline">Sign in with Google</span>
      </Button>
    );
  }

  const user = session.user;
  const initial = (user.name || user.email || "U").charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={user.name || "Account menu"}>
          {user.image && !avatarError ? (
            // Google (lh3.googleusercontent.com) avatars 403 when the browser
            // sends a Referer, so request them with no referrer; fall back to the
            // initial badge if the image still fails to load.
            <img
              src={user.image}
              alt={user.name || "User"}
              referrerPolicy="no-referrer"
              onError={() => setAvatarError(true)}
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {initial}
            </div>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 text-sm font-medium">
          {user.name || "User"}
        </div>
        <div className="px-2 py-1 text-xs text-muted-foreground">
          {user.email}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => handleSignOut()}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

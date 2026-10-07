"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// `next-themes` only knows the resolved theme on the client. Reading `theme`
// during the server render produces undefined, which would mismatch the
// hydrated value and trigger a React hydration warning. We gate the actual
// <Select value> on a mounted flag so the first paint is theme-agnostic.
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Choose how the site looks. &ldquo;System&rdquo; follows your device&rsquo;s light/dark
          preference.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label htmlFor="theme">Theme</Label>
          <Select
            value={mounted ? theme ?? "system" : "system"}
            onValueChange={(value) => setTheme(value)}
            disabled={!mounted}
          >
            <SelectTrigger id="theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

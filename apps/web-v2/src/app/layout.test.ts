import { describe, expect, test } from "bun:test";

import { viewport } from "./layout";

describe("root layout viewport metadata", () => {
  test("uses the dark mobile canvas and includes the safe-area viewport", () => {
    expect(viewport).toMatchObject({
      viewportFit: "cover",
      colorScheme: "dark",
      themeColor: "#040d14",
    });
  });
});

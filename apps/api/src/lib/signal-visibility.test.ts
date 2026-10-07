import { describe, expect, test } from "bun:test";
import { isProfessorUser } from "./signal-visibility.js";

describe("isProfessorUser", () => {
  test("accepts the professor account by its exact email", () => {
    expect(isProfessorUser({ email: "napindc@vt.edu" })).toBe(true);
    expect(isProfessorUser({ email: " NAPINDC@VT.EDU " })).toBe(true);
  });

  test("does not grant access based on a professor-like name or another email", () => {
    expect(isProfessorUser({ username: "Professor" })).toBe(false);
    expect(isProfessorUser({ name: "Professor" })).toBe(false);
    expect(isProfessorUser({ email: "napindc@example.com" })).toBe(false);
  });
});

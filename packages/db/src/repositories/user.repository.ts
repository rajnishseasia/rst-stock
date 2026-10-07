/**
 * User Repository
 *
 * Data access layer for user operations.
 * All database queries for users go through this repository.
 */

import { eq } from "drizzle-orm";
import type { PoolDb } from "../connections/pool.js";
import { users, type User, type NewUser } from "../schema/users.js";

export class UserRepository {
  constructor(private db: PoolDb) {}

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.id, id),
    });
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.email, email),
    });
  }

  /**
   * Find user by name
   */
  async findByName(name: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.name, name),
    });
  }

  /**
   * Create a new user
   */
  async create(data: NewUser): Promise<User> {
    const [user] = await this.db.insert(users).values(data).returning();
    if (!user) {
      throw new Error("Failed to create user");
    }
    return user;
  }

  /**
   * Update user by ID
   */
  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    const [user] = await this.db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  }

  /**
   * Delete user by ID
   */
  async delete(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }
}

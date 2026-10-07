/**
 * Chat Conversations Router
 *
 * Backs the AI Chat panel's saved-history sidebar: list / load / rename /
 * delete. Conversation rows are written from the chat stream itself (see
 * `apps/api/src/lib/chat/stream.ts`), not from here — this router is
 * read-mostly.
 *
 * All procedures are scoped to the authenticated user; we never trust the
 * caller's `userId` from the input — it's always taken from `ctx.userId`.
 */

import { TRPCError } from "@trpc/server";
import { schema } from "@trade-bot/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

export const chatConversationsRouter = router({
  /**
   * Most-recent-first list for the sidebar. Returns minimal columns — the
   * full transcript is fetched lazily via `get`.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.chatConversations.findMany({
      where: (c, { eq }) => eq(c.userId, ctx.userId),
      columns: {
        id: true,
        title: true,
        accountMode: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: (c, { desc }) => [desc(c.updatedAt)],
      limit: 200,
    });
    return rows;
  }),

  /**
   * Full transcript for a single conversation. Returns null when the
   * conversation doesn't belong to the caller (or doesn't exist) so the
   * client can render a clean empty state without a 404 toast.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const convo = await ctx.db.query.chatConversations.findFirst({
        where: (c, { and, eq }) =>
          and(eq(c.id, input.id), eq(c.userId, ctx.userId)),
      });
      if (!convo) return null;

      const messages = await ctx.db.query.chatMessages.findMany({
        where: (m, { eq }) => eq(m.conversationId, convo.id),
        orderBy: (m, { asc }) => [asc(m.createdAt)],
      });

      return {
        id: convo.id,
        title: convo.title,
        accountMode: convo.accountMode,
        createdAt: convo.createdAt,
        updatedAt: convo.updatedAt,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          metadata: m.metadata,
          createdAt: m.createdAt,
        })),
      };
    }),

  rename: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Confirm ownership before mutating; .where on (id, userId) makes the
      // update a no-op if someone tries to rename another user's chat.
      const result = await ctx.db
        .update(schema.chatConversations)
        .set({ title: input.title, updatedAt: new Date() })
        .where(
          and(
            eq(schema.chatConversations.id, input.id),
            eq(schema.chatConversations.userId, ctx.userId)
          )
        )
        .returning({ id: schema.chatConversations.id });

      if (result.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
      }
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Messages cascade via the FK ON DELETE CASCADE — no manual loop.
      await ctx.db
        .delete(schema.chatConversations)
        .where(
          and(
            eq(schema.chatConversations.id, input.id),
            eq(schema.chatConversations.userId, ctx.userId)
          )
        );
      return { success: true };
    }),
});

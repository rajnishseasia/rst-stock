import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@trade-bot/api";

export const trpc = createTRPCReact<AppRouter>();

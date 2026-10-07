import { z } from "zod";

export const AlpacaConfigSchema = z.object({
  keyId: z.string().min(1, "API Key ID is required"),
  secretKey: z.string().min(1, "Secret Key is required"),
  paper: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
});

export type AlpacaConfig = z.infer<typeof AlpacaConfigSchema>;

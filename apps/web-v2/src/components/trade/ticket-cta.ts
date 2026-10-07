/**
 * Shared submit-CTA fills for both trade tickets. The direction color IS the
 * decision cue on a ticket, so equity Buy/Sell and perp Long/Short must render
 * the identical solid green/red pair; gold stays reserved for brand accents
 * (focus rings, risk chips), never for a directional submit.
 */
export const TICKET_CTA_POSITIVE = "bg-green-500 text-black hover:bg-green-400";
export const TICKET_CTA_NEGATIVE = "bg-red-500 text-white hover:bg-red-400";

const ALPACA_CLIENT_ORDER_ID_MAX_LENGTH = 48;

export function createOrderClientId(
  uuid: () => string = () => globalThis.crypto.randomUUID(),
): string {
  return `ord_${uuid()}`.slice(0, ALPACA_CLIENT_ORDER_ID_MAX_LENGTH);
}

export function deriveOrderClientId(base: string, suffix: string): string {
  const tail = `-${suffix}`;
  if (!base || !suffix || tail.length >= ALPACA_CLIENT_ORDER_ID_MAX_LENGTH) {
    throw new Error("A valid order client ID base and suffix are required");
  }
  return `${base.slice(0, ALPACA_CLIENT_ORDER_ID_MAX_LENGTH - tail.length)}${tail}`;
}

export class SubmitIntentStore {
  private active: { fingerprint: string; id: string } | undefined;

  constructor(private readonly createId: () => string = createOrderClientId) {}

  get(fingerprint: string): string {
    if (this.active?.fingerprint === fingerprint) return this.active.id;
    const id = this.createId();
    this.active = { fingerprint, id };
    return id;
  }

  complete(id: string | undefined): void {
    if (this.active?.id === id) this.active = undefined;
  }
}

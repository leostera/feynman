// The card processor's API. Each charge carries the order as its idempotency key, so a
// repeat of the same order is answered without charging again.
export interface Charged {
  order: string;
}

export async function charge(order: string): Promise<Charged> {
  const response = await fetch("https://bank.example/charges", {
    method: "POST",
    headers: { "Idempotency-Key": order },
    body: JSON.stringify({ order }),
  });
  if (!response.ok) throw new Error(`charge ${order}: ${response.status}`);
  return { order };
}

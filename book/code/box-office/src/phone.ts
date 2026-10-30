// The phone app: what a person presses, and what they see.
export async function holdSeat(api: (path: string) => Promise<Response>): Promise<"holding" | "browsing"> {
  const { held } = (await (await api("/hold")).json()) as { held: boolean };
  return held ? "holding" : "browsing";
}

export async function pay(api: (path: string) => Promise<Response>): Promise<"done" | "browsing"> {
  const { ticket } = (await (await api("/pay")).json()) as { ticket: boolean };
  return ticket ? "done" : "browsing";
}

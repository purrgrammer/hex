/**
 * Hex's tools, from the runtime's side of the wire.
 *
 * The implementations are not here and cannot be: `chat.respond` answers a
 * specific Nostr message, in the room it arrived in, signed by a key only the
 * Hex process holds. So a tool here is a `fetch` to Hex's loopback bridge, and
 * everything that knows about relays stays over there.
 *
 * The session id comes from `ctx.session`, never from the model. It is what Hex
 * looks the room up by, and a model that could name it could address one
 * correspondent's answer into another's conversation.
 */

const BASE = process.env.HEX_BRIDGE_URL ?? "http://127.0.0.1:2777";
const TOKEN = process.env.HEX_BRIDGE_TOKEN ?? "";

export interface HexToolResult {
  ok: boolean;
  output: string;
}

export async function callHex(
  session: string,
  callId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<HexToolResult> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ session, callId, name, arguments: args }),
    });
  } catch (error) {
    // Said plainly rather than thrown: a model told the bridge is down can say
    // so, where a thrown step just fails the turn with nobody the wiser.
    return {
      ok: false,
      output: `hex is not reachable at ${BASE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok && response.status !== 200)
    return { ok: false, output: `hex refused the call: ${response.status}` };

  const body = (await response.json()) as Partial<HexToolResult>;
  return {
    ok: body.ok === true,
    output: typeof body.output === "string" ? body.output : "",
  };
}

/**
 * Which of Hex's tools THIS session may use.
 *
 * The catalogue depends on the channel, and only Hex knows the channel. A run
 * asked for over a gift wrap has no room, so it gets no `chat.*` — offering
 * them anyway hands a speaking tool to a model with nobody to speak to, and it
 * uses it: the answer goes nowhere and the run reads as one that had nothing to
 * say.
 *
 * A failure is an EMPTY list, not a thrown step. The chat tools are the ones
 * resolved this way, and a bridge that is briefly unreachable should cost a
 * turn its ability to speak rather than the whole turn.
 */
export async function hexTools(session: string): Promise<Set<string>> {
  try {
    const response = await fetch(
      `${BASE}/tools?session=${encodeURIComponent(session)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    if (!response.ok) return new Set();
    const body = (await response.json()) as { tools?: { name?: unknown }[] };
    return new Set(
      (body.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
        // Hex's canonical ids carry a dot; a provider takes only
        // `[a-zA-Z0-9_-]`, so the wire spelling is the underscore one.
        .map((name) => name.replace(".", "_")),
    );
  } catch {
    return new Set();
  }
}

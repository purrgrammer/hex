/**
 * Reading a thread off NIP-10 `e` tags — the root, and the immediate parent.
 *
 * Three protocols thread three different ways, and only one of them writes the
 * root down where a reader can see it:
 *
 * - **Concord** (kind 1111, NIP-22) puts the root in an uppercase `E` and the
 *   parent in a lowercase `e`. Unambiguous; see `threadRootOf` in `concord.ts`.
 * - **NIP-17** (kind 14) threads with NIP-10 `e` tags, which is what this file
 *   is for: a `root` marker, a `reply` marker, and a deprecated positional form
 *   that predates both.
 * - **NIP-29** (kind 9) has no root at all. NIP-C7 quotes the parent with `q`
 *   and stops there, so a group thread is a chain of parents and nothing else.
 *   That is why the store binds each message it handles to its session as well
 *   as the thread root: one hop up the chain is all a kind 9 ever offers, and
 *   it is enough when the hop lands on something Hex has seen.
 *
 * Not `getNip10References` from applesauce: it memoises on a symbol it sets on
 * the object, and half the things this is handed are plain rows rebuilt from
 * the queue rather than events. The rules are twenty lines.
 */

/** Anything carrying tags — a signed event, a rumor, or a row read back. */
export interface Tagged {
  tags: string[][];
}

function eTags(event: Tagged): string[][] {
  return event.tags.filter((tag) => tag[0] === "e" && tag[1]);
}

/**
 * The root of this event's thread, or nothing when it starts one.
 *
 * A marked `root` wins. Failing that, the deprecated positional form: with two
 * or more unmarked `e` tags the FIRST is the root and the last is the parent,
 * and with exactly one the tag means both — so a lone tag is reported here as
 * well, which threads a pre-marker reply under its parent. One level shallower
 * than the truth, and visible, which is the trade a reader wants over an orphan.
 */
export function nip10Root(event: Tagged): string | undefined {
  const tags = eTags(event);
  const marked = tags.find((tag) => tag[3] === "root");
  if (marked) return marked[1];
  const unmarked = tags.filter((tag) => !tag[3]);
  return unmarked[0]?.[1];
}

/**
 * The immediate parent, which is not always the root.
 *
 * A marked `reply` wins; otherwise the LAST unmarked tag, which is where the
 * positional form puts it. A `mention` is neither and is never either.
 */
export function nip10Parent(event: Tagged): string | undefined {
  const tags = eTags(event);
  const marked = tags.find((tag) => tag[3] === "reply");
  if (marked) return marked[1];
  const unmarked = tags.filter((tag) => !tag[3]);
  return unmarked.at(-1)?.[1];
}

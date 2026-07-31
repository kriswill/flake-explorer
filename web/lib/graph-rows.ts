/**
 * Turning a loaded dependency graph into rows to render.
 *
 * A DAG unrolled from a node repeats subtrees endlessly — the nixos system
 * graph reaches 18,765 nodes through 133,288 edges, and one node (`bash`) is
 * depended on by 10,384 of them. Two rules keep that finite and honest:
 *
 *   - a node is rendered IN FULL at its first occurrence in document order;
 *     later occurrences are `repeat` leaves pointing back at it;
 *   - a node already on its own ancestor path is a `cycle` leaf.
 *
 * Both are dead ends, so the walk descends into each node at most once and
 * the row count is bounded by the graph rather than by the unrolled tree.
 *
 * The walk uses an EXPLICIT STACK and never recurses: the call stack does not
 * grow with graph depth, so no document — however deep, however cyclic — can
 * overflow it. `buildGraphIndexes` holds the same property for the same
 * reason, and P3's traversals inherit it from here.
 *
 * Everything is a pure function of its arguments, which is what makes the
 * rendered result identical between renders for identical inputs.
 */

import type { GraphIndexes } from "./indexes"
import { dependenciesOf, dependentsOf } from "./indexes"

/** Which way to walk: toward what a node needs, or toward what needs it. */
export type Direction = "deps" | "dependents"

export interface GraphRow {
  /** Index into `GraphData.nodes`. */
  node: number
  /** 0 for the anchor's own children. */
  depth: number
  /**
   * Unique within a walk, and stable for identical inputs — safe as an
   * `{#each}` key. `<parent>:<node>` suffices for uniqueness precisely
   * because only a `primary` row is ever descended into, so no parent's
   * child list is walked twice.
   */
  key: string
  /**
   * `primary` — rendered in full, the only kind that may expand.
   * `repeat`  — this node is already rendered above; see `firstKey`.
   * `cycle`   — this node is on this row's own ancestor path.
   */
  kind: "primary" | "repeat" | "cycle"
  /** `repeat` rows only: the key of the occurrence rendered in full. */
  firstKey?: string
  /** Children in the walk's direction — exactly what expanding reveals. */
  childCount: number
  expanded: boolean
  /** Last child of its parent; `tree-connectors.css` needs it for the rail. */
  lastSibling: boolean
}

export interface GraphRowsResult {
  rows: GraphRow[]
  /** Rows the walk WOULD have emitted — the denominator of "showing N of M". */
  total: number
  /** `total - rows.length`; 0 when the budget did not bite. */
  truncated: number
}

/**
 * Stack items. `row` emits one row; `close` pops the node it names back off
 * the current ancestor path once its whole subtree has been walked.
 *
 * Carrying the ancestor path as a live set that is pushed and popped — rather
 * than handing each row a copy of its ancestors — is what keeps the walk
 * linear: the membership test is O(1) and no per-row array is allocated. A
 * copied path would be O(depth) per row, i.e. quadratic in a deep chain.
 */
type Item =
  | { close: false; node: number; parent: number; depth: number; lastSibling: boolean }
  | { close: true; node: number }

const childrenOf = (gx: GraphIndexes, i: number, dir: Direction): ArrayLike<number> =>
  dir === "deps" ? dependenciesOf(gx, i) : dependentsOf(gx, i)

/**
 * Rows for the subtree under `anchor`, in DFS pre-order. `anchor` itself is
 * not a row — the caller already renders it as the thing being expanded.
 *
 * `open` holds NODE INDICES, not positions. That is sound rather than lossy
 * because a node has at most one `primary` occurrence per walk and only a
 * `primary` may expand, so "this node is expanded" cannot be ambiguous.
 *
 * `budget` caps emitted rows; `total` still counts what the walk would have
 * produced, so a truncation label is read off the same walk as the rows it
 * describes and cannot drift from them. Pass `Infinity` for no cap.
 */
export function buildGraphRows(
  gx: GraphIndexes,
  anchor: number,
  open: ReadonlySet<number>,
  dir: Direction,
  budget: number,
): GraphRowsResult {
  const rows: GraphRow[] = []
  const firstKeyOf = new Map<number, string>()
  const onPath = new Set<number>([anchor])
  const stack: Item[] = []
  let total = 0

  /** Children pushed in reverse so the stack pops them in document order. */
  const pushChildren = (parent: number, depth: number) => {
    const kids = childrenOf(gx, parent, dir)
    for (let k = kids.length - 1; k >= 0; k--) {
      stack.push({
        close: false,
        node: kids[k] as number,
        parent,
        depth,
        lastSibling: k === kids.length - 1,
      })
    }
  }

  pushChildren(anchor, 0)

  while (stack.length) {
    const item = stack.pop() as Item
    if (item.close) {
      onPath.delete(item.node)
      continue
    }
    const { node, parent, depth, lastSibling } = item
    const key = `${parent}:${node}`

    let kind: GraphRow["kind"]
    let firstKey: string | undefined
    if (onPath.has(node)) {
      kind = "cycle"
    } else if (firstKeyOf.has(node)) {
      kind = "repeat"
      firstKey = firstKeyOf.get(node)
    } else {
      kind = "primary"
      firstKeyOf.set(node, key)
    }

    const childCount = childrenOf(gx, node, dir).length
    const expanded = kind === "primary" && childCount > 0 && open.has(node)

    total++
    if (rows.length < budget) {
      const row: GraphRow = { node, depth, key, kind, childCount, expanded, lastSibling }
      if (firstKey !== undefined) row.firstKey = firstKey
      rows.push(row)
    }

    if (expanded) {
      onPath.add(node)
      stack.push({ close: true, node })
      pushChildren(node, depth + 1)
    }
  }

  return { rows, total, truncated: total - rows.length }
}

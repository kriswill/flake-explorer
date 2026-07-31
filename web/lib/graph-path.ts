/**
 * "Why is this here" — the shortest dependency path from a graph's root to a
 * node.
 *
 * The measured reality this is shaped by: paths are SHORT (median 4-5 hops,
 * p90 7-10, longest 21-24 across the real documents), so a breadcrumb chain
 * fits and no tree machinery is needed — but they are frequently NOT UNIQUE.
 * On the system graph 2,057 of 18,764 reachable nodes (11%) are reached by
 * more than one shortest-path predecessor, one of them by 157, and a single
 * node has 888 distinct shortest paths of identical length. So the caller
 * needs to know not just a path but HOW MANY there are, because "the shortest
 * path" is not a well-defined object for roughly one node in nine and a UI
 * that says "the" would be lying by article.
 *
 * Both passes are O(nodes + edges) and neither recurses — the same property
 * buildGraphIndexes and buildGraphRows hold, so no graph, however deep, can
 * overflow a stack here.
 */

import type { GraphIndexes } from "./indexes"
import { dependenciesOf } from "./indexes"

/**
 * Ceiling for the distinct-path count. Real maxima are in the hundreds, but a
 * chain of k diamonds has 2^k shortest paths, and past 2^53 a running total
 * stops being an integer. Reporting a capped lower bound the caller can see is
 * honest; printing a silently-wrong number is not.
 */
export const PATH_COUNT_CAP = 1_000_000

export interface GraphPath {
  /** Root → target inclusive. EMPTY when the target is the root, and also
   *  when the target is unreachable — read `reachable` to tell those apart. */
  hops: number[]
  /** `hops.length - 1`, or 0 for the root. The SHORTEST-PATH distance — never
   *  the depth at which some expansion happened to render the node. */
  distance: number
  reachable: boolean
  /** Distinct shortest paths of exactly this length. 0 when unreachable, 1
   *  when the path is unique. Not the number of immediate predecessors. */
  pathCount: number
  /** `pathCount` hit PATH_COUNT_CAP and is a lower bound. */
  pathCountCapped: boolean
}

const UNREACHED = -1

/**
 * A shortest path from `root` to `target`, with a count of how many equally
 * short ones exist.
 *
 * Ties are broken deterministically rather than arbitrarily: BFS drains the
 * frontier in insertion order and every adjacency row is ascending and
 * deduplicated (guaranteed by the extractor and validated in P1), so a node's
 * recorded parent is the lowest-index node on the previous level that reaches
 * it. That is a total order, which is what makes this function pure — the same
 * inputs always produce the same path, so a shared link shows the same route
 * to the next reader.
 */
export function shortestPathTo(gx: GraphIndexes, root: number, target: number): GraphPath {
  const n = gx.revOffsets.length - 1

  // Pass 1 — BFS. An array with a head cursor, not shift(): shift() on a
  // 18,765-element queue is O(n) per pop and would make this quadratic.
  const dist = new Int32Array(n).fill(UNREACHED)
  const parent = new Int32Array(n).fill(UNREACHED)
  dist[root] = 0
  const queue = [root]
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number
    for (const t of dependenciesOf(gx, i)) {
      if (dist[t] === UNREACHED) {
        dist[t] = (dist[i] as number) + 1
        parent[t] = i
        queue.push(t)
      }
    }
  }

  if (dist[target] === UNREACHED) {
    return { hops: [], distance: 0, reachable: false, pathCount: 0, pathCountCapped: false }
  }
  if (target === root) {
    return { hops: [], distance: 0, reachable: true, pathCount: 1, pathCountCapped: false }
  }

  // Walk the parent chain back, iteratively. Bounded by dist[target], which
  // BFS already bounded by the number of nodes.
  const hops: number[] = []
  for (let i = target; i !== UNREACHED; i = parent[i] as number) hops.push(i)
  hops.reverse()

  // Pass 2 — count DISTINCT shortest paths, not predecessors. `queue` is
  // already in nondecreasing-distance order (that is what BFS produces), so
  // one sweep over it propagates the counts with every predecessor of a node
  // settled before the node itself.
  let capped = false
  const ways = new Float64Array(n)
  ways[root] = 1
  for (const i of queue) {
    const w = ways[i] as number
    if (w === 0) continue
    for (const t of dependenciesOf(gx, i)) {
      if (dist[t] === (dist[i] as number) + 1) {
        const sum = (ways[t] as number) + w
        if (sum >= PATH_COUNT_CAP) {
          ways[t] = PATH_COUNT_CAP
          capped = true
        } else {
          ways[t] = sum
        }
      }
    }
  }

  const pathCount = ways[target] as number
  return {
    hops,
    distance: hops.length - 1,
    reachable: true,
    pathCount,
    // Only claim a cap if THIS node's count is the one that saturated.
    pathCountCapped: capped && pathCount >= PATH_COUNT_CAP,
  }
}

import type { WalletEdge } from "./walletGraph.js";

export interface ClusterRisk {
  wallets: string[];
  insiderRisk: number;
}

export function scoreClusterRisk(edges: WalletEdge[]): ClusterRisk[] {
  const clusters = new Map<string, { members: Set<string>; score: number }>();
  for (const edge of edges) {
    const clusterKey = edge.walletA.slice(0, 7);
    const cluster = clusters.get(clusterKey) ?? { members: new Set<string>(), score: 0 };
    cluster.members.add(edge.walletA);
    cluster.members.add(edge.walletB);
    cluster.score += edge.relationScore;
    clusters.set(clusterKey, cluster);
  }

  return [...clusters.values()].map((cluster) => ({
    wallets: [...cluster.members],
    insiderRisk: Number(Math.min(1, cluster.score / (cluster.members.size * 8)).toFixed(3))
  }));
}

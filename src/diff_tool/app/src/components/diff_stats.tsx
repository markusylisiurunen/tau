type DiffStatsProps = {
  additions: number;
  deletions: number;
  className?: string;
};

export function DiffStats({ additions, deletions, className }: DiffStatsProps) {
  const resolvedClassName = ["diff-stats", className].filter(Boolean).join(" ");

  return (
    <span className={resolvedClassName}>
      <span className="stat-add">+{additions}</span>
      <span className="stat-del">-{deletions}</span>
    </span>
  );
}

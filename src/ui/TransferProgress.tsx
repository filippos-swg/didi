import { formatBytes, formatDuration } from "../format.ts";

export function TransferProgress({ done, total, bytesPerSecond, verb }: { done: number; total: number; bytesPerSecond: number | null; verb: string }) {
  const parts = [`${formatBytes(done)} of ${formatBytes(total)} ${verb}`];
  if (bytesPerSecond !== null && bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
    if (done < total) parts.push(`about ${formatDuration((total - done) / bytesPerSecond)} left`);
  }
  return (
    <div className="progress">
      <progress max={total === 0 ? 1 : total} value={total === 0 ? 0 : done} aria-label="Transfer progress" />
      <p className="progress-text">{parts.join(" · ")}</p>
    </div>
  );
}

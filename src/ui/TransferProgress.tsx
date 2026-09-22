import { formatBytes, formatDuration } from "../format.ts";

interface Props {
  done: number;
  total: number;
  bytesPerSecond: number | null;
  /** Seconds since anything moved, once that counts as a stall. */
  stalledSeconds: number | null;
  verb: "delivered" | "received";
}

export function TransferProgress({ done, total, bytesPerSecond, stalledSeconds, verb }: Props) {
  const parts = [`${formatBytes(done)} of ${formatBytes(total)} ${verb}`];
  if (stalledSeconds === null && bytesPerSecond !== null && bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
    if (done < total) parts.push(`about ${formatDuration((total - done) / bytesPerSecond)} left`);
  }
  return (
    <div className="progress">
      <progress max={total === 0 ? 1 : total} value={total === 0 ? 0 : done} aria-label="Transfer progress" />
      <p className="progress-text">{parts.join(" · ")}</p>
      {stalledSeconds !== null && (
        <p className="notice stalled" role="status">
          Nothing {verb} for {stalledSeconds} s. Waiting for the connection to recover…
        </p>
      )}
    </div>
  );
}

import { describeCounts, explain, type ConnectionReport } from "../net/connection-report.ts";

/** Shown under a "couldn't connect" message: the likely cause, and the facts behind it. */
export function ConnectionDetails({ report, other }: { report: ConnectionReport; other: "sender" | "recipient" }) {
  const pairs = report.pairs;
  return (
    <div className="connection-details">
      <p>{explain(report, other)}</p>
      <details>
        <summary>Connection details</summary>
        <dl>
          <dt>Your browser found</dt>
          <dd>{describeCounts(report.local)}</dd>
          <dt>The {other}’s browser sent</dt>
          <dd>{describeCounts(report.remote)}</dd>
          <dt>Paths tried</dt>
          <dd>{pairs === null ? "not reported by this browser" : `${pairs.tried} tried, ${pairs.succeeded} worked, ${pairs.failed} failed`}</dd>
          <dt>Ended</dt>
          <dd>{report.ending === "timeout" ? `no connection after ${report.seconds} s` : `the browser gave up after ${report.seconds} s`}</dd>
        </dl>
      </details>
    </div>
  );
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateKind, describeCounts, emptyCounts, explain, type ConnectionReport } from "../../src/net/connection-report.ts";

test("candidate types are read from candidate lines", () => {
  assert.equal(candidateKind("candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host generation 0"), "host");
  assert.equal(candidateKind("candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx raddr 192.0.2.1 rport 54321"), "srflx");
  assert.equal(candidateKind("candidate:3 1 udp 41885439 198.51.100.4 3478 typ relay raddr 0.0.0.0 rport 0"), "relay");
  assert.equal(candidateKind("candidate:4 1 tcp 1518280447 abc.local 9 typ host tcptype active"), "host");
  assert.equal(candidateKind("garbage"), null);
});

function report(local: Partial<ReturnType<typeof emptyCounts>>, remote: Partial<ReturnType<typeof emptyCounts>>): ConnectionReport {
  return { ending: "timeout", seconds: 20, local: { ...emptyCounts(), ...local }, remote: { ...emptyCounts(), ...remote }, pairs: null };
}

test("the explanation names the most likely cause", () => {
  assert.match(explain(report({ host: 2, srflx: 1 }, {}), "sender"), /No network addresses arrived from the sender’s browser/);
  assert.match(explain(report({ host: 2 }, { host: 1, srflx: 1 }), "sender"), /^Your browser couldn’t find its public internet address/);
  assert.match(explain(report({ host: 2, srflx: 1 }, { host: 3 }), "recipient"), /^The recipient’s browser couldn’t find its public internet address/);
  assert.match(explain(report({ host: 2, srflx: 1 }, { host: 1, srflx: 1 }), "sender"), /Only a relay server \(TURN\) would get through/);
});

test("counts read as plain words", () => {
  assert.equal(describeCounts({ host: 2, srflx: 1, prflx: 1, relay: 0 }), "2 on its own network, 2 public, 0 relay");
});

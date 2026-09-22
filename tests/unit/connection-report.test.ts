import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateKind, describeCounts, emptyCounts, explain, publicAddress, type ConnectionReport } from "../../src/net/connection-report.ts";

test("candidate types are read from candidate lines", () => {
  assert.equal(candidateKind("candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host generation 0"), "host");
  assert.equal(candidateKind("candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx raddr 192.0.2.1 rport 54321"), "srflx");
  assert.equal(candidateKind("candidate:3 1 udp 41885439 198.51.100.4 3478 typ relay raddr 0.0.0.0 rport 0"), "relay");
  assert.equal(candidateKind("candidate:4 1 tcp 1518280447 abc.local 9 typ host tcptype active"), "host");
  assert.equal(candidateKind("garbage"), null);
});

test("only server-reflexive candidates yield a public address", () => {
  assert.equal(publicAddress("candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx raddr 192.0.2.1 rport 54321"), "203.0.113.9");
  assert.equal(publicAddress("candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host generation 0"), null);
});

function report(
  local: Partial<ReturnType<typeof emptyCounts>>,
  remote: Partial<ReturnType<typeof emptyCounts>>,
  samePublicAddress = false,
): ConnectionReport {
  return { ending: "timeout", seconds: 20, local: { ...emptyCounts(), ...local }, remote: { ...emptyCounts(), ...remote }, pairs: null, samePublicAddress };
}

test("the explanation names the most likely cause", () => {
  assert.match(explain(report({ host: 2, srflx: 1 }, {}), "sender"), /No network addresses arrived from the sender’s browser/);
  assert.match(explain(report({ host: 2 }, { host: 1, srflx: 1 }), "sender"), /^Your browser couldn’t find its public internet address/);
  assert.match(explain(report({ host: 2, srflx: 1 }, { host: 3 }), "recipient"), /^The recipient’s browser couldn’t find its public internet address/);
  assert.match(explain(report({ host: 2, srflx: 1 }, { host: 1, srflx: 1 }), "sender"), /Only a relay server \(TURN\) would get through/);
  // Peter's first attempt: same Wi-Fi, so the same public address, and local discovery failed.
  assert.match(explain(report({ host: 1, srflx: 1 }, { host: 1, srflx: 1 }, true), "sender"), /^You and the sender seem to be on the same network/);
});

test("counts read as plain words", () => {
  assert.equal(describeCounts({ host: 2, srflx: 1, prflx: 1, relay: 0 }), "2 on its own network, 2 public, 0 relay");
});

test("private addresses are told apart from public ones", async () => {
  const { isPrivateAddress } = await import("../../src/net/peer.ts");
  for (const address of ["10.0.0.4", "192.168.30.117", "172.20.1.1", "169.254.3.3", "127.0.0.1", "fd12:3456::1", "fe80::1c", "::1", "4f1c-abc.local"]) {
    assert.ok(isPrivateAddress(address), address);
  }
  for (const address of ["212.247.90.82", "172.32.0.1", "100.64.0.1", "8.8.8.8", "2001:db8::1", ""]) {
    assert.ok(!isPrivateAddress(address), address);
  }
});

test("IPv6 subnets are compared on their first 64 bits", async () => {
  const { ipv6Prefix64 } = await import("../../src/net/peer.ts");
  assert.equal(ipv6Prefix64("2001:db8:85a3:12::8a2e:370:7334"), "2001:db8:85a3:12");
  assert.equal(ipv6Prefix64("2001:0db8:85a3:0012:ffff::1"), "2001:db8:85a3:12");
  assert.equal(ipv6Prefix64("fe80::1c%en0"), "fe80:0:0:0");
  assert.equal(ipv6Prefix64("::1"), "0:0:0:0");
  assert.equal(ipv6Prefix64("192.168.1.2"), null);
  assert.equal(ipv6Prefix64("::ffff:192.168.1.2"), null);
  assert.equal(ipv6Prefix64("1::2::3"), null);
  assert.equal(ipv6Prefix64("abc.local"), null);
});

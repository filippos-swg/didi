import type { Route } from "../net/peer.ts";

export function routeText(route: Route): string {
  switch (route.kind) {
    case "direct":
      return route.sameNetwork ? "Direct connection, same network" : "Direct connection";
    case "relayed":
      return "Relayed connection";
    case "unknown":
      return "Connection type unknown";
  }
}

export function RouteLabel({ route }: { route: Route }) {
  return (
    <p className="route" data-route={route.kind}>
      {routeText(route)}
    </p>
  );
}

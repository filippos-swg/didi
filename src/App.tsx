import { ReceivePage } from "./receive/ReceivePage.tsx";
import { ReceiverSession } from "./receive/receiver-session.ts";
import { SendPage } from "./send/SendPage.tsx";
import { SenderSession } from "./send/sender-session.ts";

// One page load is one session. It is created outside React so that
// StrictMode's double mounting cannot open two connections.
const page =
  location.pathname === "/r" ? <ReceivePage session={new ReceiverSession(location.hash)} /> : <SendPage session={new SenderSession()} />;

export function App() {
  return page;
}

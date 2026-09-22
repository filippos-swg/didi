export function App() {
  const receiving = location.pathname === "/r";
  return (
    <main>
      <h1>didi</h1>
      <p>{receiving ? "Receive" : "Send"}</p>
    </main>
  );
}

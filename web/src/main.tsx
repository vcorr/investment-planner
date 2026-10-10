import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";
import { createSupabase } from "./supabase.ts";

const root = createRoot(document.getElementById("root")!);
try {
  root.render(
    <StrictMode>
      <App supabase={createSupabase()} />
    </StrictMode>,
  );
} catch (error) {
  root.render(<p role="alert">{error instanceof Error ? error.message : String(error)}</p>);
}

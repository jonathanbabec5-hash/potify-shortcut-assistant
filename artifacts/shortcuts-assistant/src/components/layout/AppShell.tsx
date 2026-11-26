import { BottomNav } from "./BottomNav";
import { cn } from "@/lib/utils";

export type StudioMode = "standalone" | "embedded";

export interface AppShellProps {
  children: React.ReactNode;
  mode?: StudioMode;
  className?: string;
}

export function AppShell({ children, mode = "standalone", className }: AppShellProps) {
  if (mode === "embedded") {
    return (
      <div className={cn("h-full bg-background text-foreground flex flex-col font-sans selection:bg-primary/20 relative", className)}>
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className={cn("min-h-[100dvh] bg-background text-foreground flex flex-col font-sans selection:bg-primary/20 relative", className)}>
      <main className="flex-1 pb-20 md:pb-24">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}

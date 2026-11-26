import { Link, useLocation } from "wouter";
import { Wand2, ShieldCheck, Blocks, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { path: "/", label: "Generate", icon: Wand2 },
  { path: "/validate", label: "Validate", icon: ShieldCheck },
  { path: "/builder", label: "Builder", icon: Blocks },
  { path: "/about", label: "About", icon: Info },
];

export function BottomNav() {
  const [location] = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background/90 backdrop-blur-xl border-t border-border pb-safe shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.5)]">
      <div className="flex items-center justify-around h-16 md:h-20 px-2 max-w-md mx-auto w-full">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const isActive = location === path;
          return (
            <Link
              key={path}
              href={path}
              className={cn(
                "flex flex-col items-center justify-center w-full h-full gap-1 transition-all duration-300",
                isActive ? "text-accent translate-y-[-2px]" : "text-muted-foreground hover:text-foreground hover:translate-y-[-1px]"
              )}
            >
              <div className={cn(
                "relative flex items-center justify-center p-2 rounded-xl transition-all duration-300",
                isActive ? "bg-accent/10" : "bg-transparent"
              )}>
                <Icon
                  className={cn(
                    "w-6 h-6 md:w-7 md:h-7 transition-transform",
                    isActive ? "scale-110" : "scale-100"
                  )}
                  strokeWidth={isActive ? 2.5 : 2}
                />
              </div>
              <span className="text-[10px] md:text-xs font-semibold leading-none">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

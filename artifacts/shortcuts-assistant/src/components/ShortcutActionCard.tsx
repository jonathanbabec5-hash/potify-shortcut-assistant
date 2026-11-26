/**
 * ShortcutActionCard — shared display primitive.
 * Used identically on the Generate tab (result cards), Validate tab (annotated action list),
 * and Builder tab (action preview).
 *
 * Design rules:
 *   source: "schema" findings → red/orange "Compatibility issue" badge (definitive)
 *   source: "ai"     findings → yellow "AI analysis" badge + tooltip (probabilistic)
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ValidationFinding } from '@workspace/api-client-react';

export interface ShortcutActionCardProps {
  /** 1-based display index */
  index: number;
  /** Human-readable action name */
  displayName: string;
  /** Plain-English explanation text (optional) */
  explanation?: string;
  /** Short parameter summary line (optional) */
  parameterSummary?: string;
  /** Findings targeting this action index */
  findings?: ValidationFinding[];
  /** CSS transition delay for staggered reveal animation (ms) */
  animationDelay?: number;
  className?: string;
}

export function ShortcutActionCard({
  index,
  displayName,
  explanation,
  parameterSummary,
  findings = [],
  animationDelay,
  className,
}: ShortcutActionCardProps) {
  const schemaFindings = findings.filter(f => f.source === 'schema');
  const aiFindings = findings.filter(f => f.source === 'ai');
  const hasErrors = schemaFindings.some(f => f.severity === 'error');

  return (
    <div
      className={cn(
        'rounded-xl border bg-card shadow-[var(--shadow-sm)] p-4 flex gap-4 items-start',
        'animate-in fade-in slide-in-from-bottom-2',
        hasErrors ? 'border-destructive/30' : 'border-card-border',
        className,
      )}
      style={
        animationDelay !== undefined
          ? { animationDelay: `${animationDelay}ms`, animationFillMode: 'both' }
          : undefined
      }
      data-testid={`action-card-${index}`}
    >
      {/* Step number badge */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm',
          hasErrors
            ? 'bg-destructive/10 text-destructive'
            : 'bg-primary/10 text-primary',
        )}
      >
        {index}
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <h4 className="font-semibold text-base leading-snug text-foreground">{displayName}</h4>

        {explanation && (
          <p className="text-sm text-muted-foreground leading-relaxed">{explanation}</p>
        )}

        {parameterSummary && (
          <div className="mt-1 px-2 py-1 bg-secondary/40 rounded-md text-xs font-mono text-secondary-foreground/80 truncate">
            {parameterSummary}
          </div>
        )}

        {/* Schema / compatibility findings — definitive */}
        {schemaFindings.map((f, i) => (
          <div
            key={`schema-${i}`}
            className={cn(
              'flex items-start gap-2 mt-2 text-xs px-2 py-1.5 rounded-md border',
              f.severity === 'error'
                ? 'border-destructive/30 bg-destructive/10 text-destructive-foreground'
                : 'border-orange-500/30 bg-orange-500/10 text-orange-300',
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Compatibility issue · </span>
              {f.message}
              {f.suggestion && (
                <span className="block text-[10px] opacity-70 mt-0.5">Suggestion: {f.suggestion}</span>
              )}
            </div>
          </div>
        ))}

        {/* AI findings — probabilistic, always labeled */}
        {aiFindings.map((f, i) => (
          <div
            key={`ai-${i}`}
            className="flex items-start gap-2 mt-2 text-xs px-2 py-1.5 rounded-md border border-amber-500/20 bg-amber-500/8 text-amber-300"
          >
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-semibold flex items-center gap-1">
                AI analysis
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3 h-3 opacity-50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[220px] text-xs">
                    This is an AI observation, not a confirmed error. Always test on your target device.
                  </TooltipContent>
                </Tooltip>
                {' · '}
              </span>
              {f.message}
              {f.suggestion && (
                <span className="block text-[10px] opacity-70 mt-0.5">Suggestion: {f.suggestion}</span>
              )}
            </div>
          </div>
        ))}

        {/* Source + severity badges for non-inline context */}
        {findings.length > 0 && schemaFindings.length === 0 && aiFindings.length === 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {findings.map((f, i) => (
              <Badge
                key={i}
                variant="outline"
                className={cn(
                  'text-[10px] h-4 px-1',
                  f.severity === 'error' ? 'border-destructive/40 text-destructive' :
                  f.severity === 'warning' ? 'border-orange-500/40 text-orange-400' :
                  'border-border text-muted-foreground',
                )}
              >
                {f.severity}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

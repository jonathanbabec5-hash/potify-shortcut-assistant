import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  useGenerateShortcut,
  useClarifyShortcut,
  usePlanShortcut,
  getGetShortcutFileUrl,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Wand2, AlertCircle, HelpCircle, Sparkles, CheckCircle2,
  Blocks, ArrowRight, RefreshCw, XCircle, Ban, Lock, Zap, Shield,
} from 'lucide-react';

// ─── Local types for completion gate (mirrors completion.ts) ─────────────────
interface CompletionFinding {
  severity: string;
  source: string;
  message: string;
  suggestion?: string;
  actionIdentifier?: string;
}
type CompletionStatus = 'ready' | 'incomplete' | 'unsupported' | 'validation-failed';
/**
 * The only status values the client trusts. Anything else — a response with no
 * completionStatus (an older server build), a 422 error body, a proxy error
 * page — collapses to 'unverified'.
 *
 * 'unverified' means "the server did not tell us this is complete". It is never
 * styled as success and never enables Import. The previous 'none' fallback
 * rendered a green check and "Ready to review" for exactly these cases.
 */
const KNOWN_COMPLETION_STATES: readonly CompletionStatus[] = [
  'ready',
  'incomplete',
  'unsupported',
  'validation-failed',
];
type GenerationState = CompletionStatus | 'unverified';
interface CompletionResult {
  satisfied: boolean;
  status: CompletionStatus;
  missingCapabilities: string[];
  unsupportedActions: string[];
  hollowActions: string[];
  blockingFindings: CompletionFinding[];
}
interface ChecklistItem {
  id: string;
  type: 'condition' | 'action' | 'constraint';
  description: string;
  requiredActions: string[];
  needsClarification?: boolean;
  externalDomain?: boolean;
}
import { shortcutStore } from '@/lib/store';
import { getSubjectId } from '@/lib/subject';
import { APP_VERSION } from '@/lib/app-version';
import { clearEdits } from '@/lib/edit-journal';
import { useImportStrategy } from '@/lib/import-strategy';
import { ImportFlow } from '@/components/ImportFlow';
import { ShortcutActionCard } from '@/components/ShortcutActionCard';

/**
 * A question shown in the clarification dialog. Questions come from two places:
 * the /clarify endpoint before generating, and a plan's unresolved requiredSlots
 * after viewing a plan. Both render through the same dialog.
 */
interface PendingQuestion {
  slotKey: string;
  displayName: string;
  description: string;
  enumeration?: string[];
}

const OTHER_OPTION = '__other__';

export function Generate() {
  const [, setLocation] = useLocation();
  const [description, setDescription] = useState('');
  const [showClarifyDialog, setShowClarifyDialog] = useState(false);
  const [clarificationSlots, setClarificationSlots] = useState<Record<string, string>>({});
  const [activeSlots, setActiveSlots] = useState<Record<string, unknown>>({});
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  // Slot keys where the user chose "Something else" and is typing their own value.
  const [customAnswers, setCustomAnswers] = useState<Record<string, boolean>>({});

  const generate = useGenerateShortcut();
  const clarify = useClarifyShortcut();
  const plan = usePlanShortcut();

  const result = generate.data;
  const shortcutId = result?.id ?? null;
  const fileUrl = shortcutId ? getGetShortcutFileUrl(shortcutId) : undefined;
  const imp = useImportStrategy(fileUrl);

  // ── Completion gate state ────────────────────────────────────────────────
  // The server now always returns completionStatus. The client derives a single
  // generationState that drives all import UI. Import is only offered when
  // completionStatus.satisfied === true (fileUrl will be present).
  const rawResult = result as unknown as {
    completionStatus?: CompletionResult;
    checklistSatisfied?: boolean;
    checklist?: ChecklistItem[];
  } | undefined;
  const completionStatus = rawResult?.completionStatus;
  const checklistSatisfied = rawResult?.checklistSatisfied ?? false;
  const checklist = rawResult?.checklist ?? [];
  const rawStatus = completionStatus?.status;
  const generationState: GenerationState =
    rawStatus && KNOWN_COMPLETION_STATES.includes(rawStatus)
      ? rawStatus
      : 'unverified';

  const openQuestions = (questions: PendingQuestion[], seed: Record<string, unknown> = {}) => {
    const initialSlots: Record<string, string> = {};
    for (const q of questions) {
      const existing = seed[q.slotKey];
      initialSlots[q.slotKey] = existing === undefined || existing === null ? '' : String(existing);
    }
    setClarificationSlots(initialSlots);
    setCustomAnswers({});
    setPendingQuestions(questions);
    setShowClarifyDialog(true);
  };

  const handleClarify = () => {
    if (!description.trim()) return;
    clarify.mutate(
      { data: { description } },
      {
        onSuccess: (data) => {
          if (data.needed && data.questions.length > 0) {
            openQuestions(data.questions, activeSlots);
          } else {
            handleGenerate({});
          }
        },
      },
    );
  };

  /**
   * The plan reports what it still needs instead of inventing a value. Route
   * those unresolved slots through the same dialog so the user can fill them in.
   */
  const answerPlanSlots = () => {
    const slots = plan.data?.requiredSlots ?? [];
    if (slots.length === 0) return;
    openQuestions(
      slots.map((s) => ({
        slotKey: s.key,
        displayName: s.displayName,
        description: s.description,
        enumeration: s.enumeration,
      })),
      activeSlots,
    );
  };

  const handleGenerate = (slots: Record<string, unknown>) => {
    if (!description.trim()) return;
    setActiveSlots(slots);
    generate.mutate(
      // The subject only lets the server look up whether this person agreed to
      // anything being kept. With no grant on file it is looked up and discarded.
      { data: { description, slots, subject: getSubjectId(), appVersion: APP_VERSION } },
      {
        onSuccess: (data) => {
          // A new run owns a fresh edit journal — edits made against the
          // previous shortcut must never be attributed to this one.
          clearEdits();
          shortcutStore.set(data.shortcut, data.runId ?? null);
        },
      },
    );
  };

  const handlePlan = () => {
    if (!description.trim()) return;
    plan.mutate({ data: { description, slots: activeSlots } });
  };

  const submitClarifications = () => {
    const filledSlots: Record<string, unknown> = { ...activeSlots };
    for (const [key, value] of Object.entries(clarificationSlots)) {
      if (value.trim()) filledSlots[key] = value.trim();
      else delete filledSlots[key];
    }
    setActiveSlots(filledSlots);
    setShowClarifyDialog(false);
    handleGenerate(filledSlots);
  };

  const handleStartOver = () => {
    setDescription('');
    setActiveSlots({});
    setPendingQuestions([]);
    setCustomAnswers({});
    generate.reset();
    clarify.reset();
    plan.reset();
    imp.reset();
    shortcutStore.set(null);
  };

  const hasUncertainty = result && Array.isArray(result.uncertainty) && result.uncertainty.length > 0;
  const hasAlternatives = result && Array.isArray(result.alternatives) && result.alternatives.length > 0;

  return (
    <div className="p-4 pt-8 pb-24 space-y-8 max-w-2xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-3 text-center mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/20 bg-accent/5 text-accent text-xs font-medium tracking-wide uppercase">
          <Sparkles className="w-3 h-3" />
          POTIFY Shortcut Studio
        </div>
        <h1 className="text-4xl md:text-5xl font-serif font-medium tracking-tight text-foreground">
          Build with confidence
        </h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          Describe an iOS Shortcut in plain language. We translate it into a
          structured, validated plan before any file touches your device.
        </p>
      </div>

      {/* Input card */}
      {!result && (
        <Card className="border border-card-border bg-card shadow-[var(--shadow-md)]">
          <CardContent className="p-4 space-y-4">
            <Textarea
              data-testid="input-description"
              placeholder="What should your shortcut do? Be specific: 'Every morning at 7 am, show my first calendar event and today's weather'"
              className="min-h-[140px] text-base resize-none border border-input bg-background/50 focus-visible:ring-1 focus-visible:ring-ring p-4 rounded-lg placeholder:text-muted-foreground/60"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex gap-3">
              <Button
                data-testid="button-generate"
                className="flex-1 h-12 text-base rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleClarify}
                disabled={!description.trim() || generate.isPending || clarify.isPending}
              >
                {clarify.isPending || generate.isPending ? (
                  <span className="flex items-center gap-2">
                    <Wand2 className="w-5 h-5 animate-spin" />
                    Planning…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Wand2 className="w-5 h-5" />
                    Generate Shortcut
                  </span>
                )}
              </Button>
              <Button
                variant="outline"
                data-testid="button-view-plan"
                className="h-12 px-4 rounded-lg border-border hover:bg-elevate-1"
                onClick={handlePlan}
                disabled={!description.trim() || plan.isPending}
              >
                {plan.isPending ? 'Planning…' : 'View Plan'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error state */}
      {generate.isError && (
        <Alert variant="destructive" className="animate-in slide-in-from-bottom-2 border-destructive/30 bg-destructive/10">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>Generation Failed</AlertTitle>
          <AlertDescription>
            {(generate.error as { data?: { error?: string } })?.data?.error ??
              (generate.error as Error)?.message ??
              "We couldn't generate that shortcut. Try a more specific description."}
          </AlertDescription>
        </Alert>
      )}

      {/* Plan preview */}
      {plan.data && (
        <Card className="border border-card-border bg-card/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-serif flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-primary" />
              Deterministic plan
            </CardTitle>
            <CardDescription className="text-foreground/80">
              {plan.data.goal} — iOS {plan.data.minimumIosVersion}+ · {plan.data.steps.length} steps
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {plan.data.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center text-xs font-medium shrink-0">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">{step.displayName}</p>
                  <p className="text-muted-foreground text-xs">{step.intent}</p>
                </div>
              </div>
            ))}
            {/* Unresolved details. The planner reports these rather than filling
                them with a guess, so they are actionable, not just informational. */}
            {plan.data.requiredSlots.length > 0 && (
              <div
                className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm"
                data-testid="plan-needs-input"
              >
                <p className="font-medium text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1.5">
                  <HelpCircle className="w-4 h-4" />
                  Needs your input ({plan.data.requiredSlots.length})
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  These details aren't set. Nothing has been guessed on your behalf.
                </p>
                <ul className="space-y-1 mb-3">
                  {plan.data.requiredSlots.map((slot) => (
                    <li key={slot.key} className="text-xs text-foreground">
                      <span className="font-medium">{slot.displayName}</span>
                      <span className="text-muted-foreground"> — {slot.description}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs border-amber-500/40 hover:bg-amber-500/10"
                  onClick={answerPlanSlots}
                  data-testid="button-answer-plan-slots"
                >
                  Fill these in
                </Button>
              </div>
            )}
            {plan.data.uncertainty.length > 0 && (
              <div className="mt-3 p-3 rounded-lg border border-accent/20 bg-accent/5 text-sm">
                <p className="font-medium text-accent mb-1">Uncertainty</p>
                <ul className="list-disc list-inside text-muted-foreground text-xs space-y-1">
                  {plan.data.uncertainty.map((u, i) => <li key={i}>{u}</li>)}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-700 fade-in">
          {/* Summary card — title, border, and import area change per generationState */}
          <Card className={`border shadow-[var(--shadow-md)] bg-gradient-to-b to-transparent ${
            generationState === 'ready'
              ? 'border-primary/20 from-primary/5'
              : generationState === 'unverified'
                ? 'border-amber-500/30 from-amber-500/5'
                : 'border-destructive/20 from-destructive/5'
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-xl font-serif flex items-center gap-2">
                {generationState === 'ready' && <CheckCircle2 className="w-5 h-5 text-primary" />}
                {generationState === 'incomplete' && <AlertCircle className="w-5 h-5 text-amber-500" />}
                {generationState === 'unsupported' && <Ban className="w-5 h-5 text-destructive" />}
                {generationState === 'validation-failed' && <XCircle className="w-5 h-5 text-destructive" />}
                {generationState === 'unverified' && <AlertCircle className="w-5 h-5 text-amber-500" />}
                {generationState === 'ready' && 'Ready to import'}
                {generationState === 'incomplete' && 'Shortcut incomplete'}
                {generationState === 'unsupported' && 'Capability not available'}
                {generationState === 'validation-failed' && 'Validation failed'}
                {generationState === 'unverified' && 'Completion status unavailable'}
              </CardTitle>
              <CardDescription className="text-base text-foreground/80">{result.explanation}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Compatibility bar */}
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="bg-background border-border text-foreground">
                  iOS {result.minimumIosVersion}+
                </Badge>
                <Badge variant="outline" className="bg-background border-border text-foreground">
                  {result.actions.length} Actions
                </Badge>
              </div>

              {/* ── Locked checklist chips ────────────────────────────────── */}
              {checklist.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Lock className="w-3 h-3" />
                    Locked requirements ({checklist.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {checklist.map((item) => {
                      const icon = item.type === 'condition'
                        ? <Zap className="w-3 h-3 shrink-0" />
                        : item.type === 'action'
                        ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                        : <Shield className="w-3 h-3 shrink-0" />;
                      const chipClass = checklistSatisfied
                        ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
                        : generationState === 'incomplete' || generationState === 'unsupported'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-border bg-muted/40 text-muted-foreground';
                      return (
                        <span
                          key={item.id}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${chipClass}`}
                          title={item.requiredActions.join(', ')}
                        >
                          {icon}
                          <span className="truncate max-w-[180px]">{item.description}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Completion gate failure cards ─────────────────────────── */}

              {/* incomplete: Comment-placeholder substitution detected */}
              {generationState === 'incomplete' && completionStatus && (
                <Alert className="border border-amber-500/30 bg-amber-500/10">
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                  <AlertTitle className="text-amber-700 dark:text-amber-400">
                    Placeholder actions detected
                  </AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p className="text-sm text-foreground/80">
                      The generated shortcut contains Comment actions that were substituted for
                      real capabilities — it would not do anything useful on your device.
                    </p>
                    {completionStatus.hollowActions.length > 0 && (
                      <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5">
                        {completionStatus.blockingFindings.map((f, i) => (
                          <li key={i}>{f.message}{f.suggestion ? ` — ${f.suggestion}` : ''}</li>
                        ))}
                      </ul>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* unsupported: required capability has no iOS Shortcuts action */}
              {generationState === 'unsupported' && completionStatus && (
                <Alert variant="destructive" className="border border-destructive/30 bg-destructive/10">
                  <Ban className="w-4 h-4" />
                  <AlertTitle>Not supported by iOS Shortcuts</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p className="text-sm">
                      One or more capabilities you requested cannot be implemented with iOS
                      Shortcuts actions. Import is blocked.
                    </p>
                    {completionStatus.missingCapabilities.length > 0 && (
                      <ul className="list-disc list-inside text-xs space-y-0.5 opacity-80">
                        {completionStatus.missingCapabilities.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-xs opacity-70">
                      Try the Builder guide for a manual workaround, or adjust your description to
                      remove the unsupported requirement.
                    </p>
                  </AlertDescription>
                </Alert>
              )}

              {/* validation-failed: hard structural error after retry */}
              {generationState === 'validation-failed' && completionStatus && (
                <Alert variant="destructive" className="border border-destructive/30 bg-destructive/10">
                  <XCircle className="w-4 h-4" />
                  <AlertTitle>Structural validation failed</AlertTitle>
                  <AlertDescription className="space-y-1">
                    <p className="text-sm">
                      The generated shortcut has structural errors that would prevent it from
                      running. Import is blocked until these are resolved.
                    </p>
                    {completionStatus.blockingFindings.map((f, i) => (
                      <p key={i} className="text-xs opacity-80">{f.message}</p>
                    ))}
                  </AlertDescription>
                </Alert>
              )}

              {/* Uncertainty */}
              {hasUncertainty && (
                <div className="p-3 rounded-lg border border-accent/20 bg-accent/5">
                  <p className="text-sm font-medium text-accent flex items-center gap-2">
                    <HelpCircle className="w-4 h-4" />
                    Assumptions made
                  </p>
                  <ul className="mt-2 list-disc list-inside text-xs text-muted-foreground space-y-1">
                    {result.uncertainty?.map((u, i) => <li key={i}>{u}</li>)}
                  </ul>
                </div>
              )}

              {/* Alternatives */}
              {hasAlternatives && (
                <div className="p-3 rounded-lg border border-secondary/20 bg-secondary/10">
                  <p className="text-sm font-medium text-secondary-foreground flex items-center gap-2">
                    <Blocks className="w-4 h-4" />
                    Alternative approaches
                  </p>
                  <ul className="mt-2 space-y-2">
                    {result.alternatives?.map((alt, i) => (
                      <li key={i} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{alt.label}:</span> {alt.description}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>

            <CardFooter className="flex flex-col gap-3 pt-0 pb-4 px-6">
              {/* Import button — only rendered when completionStatus.satisfied */}
              {generationState === 'ready' ? (
                <Button
                  data-testid="button-import"
                  size="lg"
                  className="w-full text-base font-semibold h-14 rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 shadow-[var(--shadow-sm)]"
                  onClick={imp.startImport}
                  disabled={!fileUrl}
                >
                  Import to Shortcuts
                </Button>
              ) : (
                <div
                  data-testid="import-blocked"
                  className="w-full h-14 rounded-lg border border-border bg-muted/40 flex items-center justify-center text-sm text-muted-foreground gap-2"
                >
                  <AlertCircle className="w-4 h-4" />
                  {generationState === 'unverified'
                    ? 'Import unavailable — the server did not confirm this shortcut is complete'
                    : `Import unavailable — shortcut is ${generationState}`}
                </div>
              )}

              {/* Path E — always present */}
              <Button
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => setLocation('/builder')}
                data-testid="link-builder-guide"
              >
                View step-by-step guide in Builder
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground/60 hover:text-muted-foreground"
                onClick={handleStartOver}
                data-testid="button-start-over"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Start over
              </Button>
            </CardFooter>
          </Card>

          {/* Action cards — staggered reveal */}
          <div className="space-y-3">
            <h3 className="text-lg font-serif font-medium px-1">How it works</h3>
            {result.actions.map((action, i) => {
              const actionFindings = result.warnings?.filter(
                (w) => w.actionIndex === i,
              ) ?? [];
              return (
                <ShortcutActionCard
                  key={i}
                  index={i + 1}
                  displayName={action.displayName}
                  explanation={action.explanation}
                  parameterSummary={action.parameterSummary}
                  findings={actionFindings}
                  animationDelay={i * 80}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Import flow dialog */}
      <ImportFlow imp={imp} onNavigateToBuilder={() => setLocation('/builder')} />

      {/* Clarification dialog */}
      <Dialog open={showClarifyDialog} onOpenChange={setShowClarifyDialog}>
        <DialogContent className="bg-card border-card-border text-foreground">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl">A few details</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              We can build a more precise shortcut if you answer these questions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {pendingQuestions.map((q) => {
              const hasOptions = !!q.enumeration && q.enumeration.length > 0;
              const isCustom = customAnswers[q.slotKey] === true;
              return (
                <div key={q.slotKey} className="space-y-2">
                  <Label htmlFor={q.slotKey} className="text-foreground font-medium">
                    {q.displayName}
                  </Label>
                  <p className="text-xs text-muted-foreground">{q.description}</p>
                  {hasOptions && !isCustom ? (
                    <select
                      id={q.slotKey}
                      data-testid={`select-${q.slotKey}`}
                      className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={clarificationSlots[q.slotKey] ?? ''}
                      onChange={(e) => {
                        // The options are suggestions, not an exhaustive list —
                        // "Something else" lets the user describe their own.
                        if (e.target.value === OTHER_OPTION) {
                          setCustomAnswers((prev) => ({ ...prev, [q.slotKey]: true }));
                          setClarificationSlots((prev) => ({ ...prev, [q.slotKey]: '' }));
                          return;
                        }
                        setClarificationSlots((prev) => ({ ...prev, [q.slotKey]: e.target.value }));
                      }}
                    >
                      <option value="">Choose…</option>
                      {q.enumeration!.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                      <option value={OTHER_OPTION}>Something else…</option>
                    </select>
                  ) : (
                    <>
                      <Input
                        id={q.slotKey}
                        data-testid={`input-${q.slotKey}`}
                        value={clarificationSlots[q.slotKey] ?? ''}
                        onChange={(e) =>
                          setClarificationSlots((prev) => ({ ...prev, [q.slotKey]: e.target.value }))
                        }
                        placeholder={`Enter ${q.displayName.toLowerCase()}…`}
                        className="bg-background border-input"
                      />
                      {hasOptions && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline"
                          onClick={() =>
                            setCustomAnswers((prev) => ({ ...prev, [q.slotKey]: false }))
                          }
                        >
                          Back to suggestions
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => { setShowClarifyDialog(false); handleGenerate(activeSlots); }}
              className="text-muted-foreground"
            >
              Skip
            </Button>
            <Button
              onClick={submitClarifications}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

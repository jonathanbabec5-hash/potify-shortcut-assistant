import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  useValidateShortcut,
  useRepairShortcut,
  useExplainShortcut,
  useDiagnoseShortcut,
  useStoreShortcutFile,
  getGetShortcutFileUrl,
} from '@workspace/api-client-react';
import type { ShortcutPlist } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ShieldCheck, AlertCircle, Info, UploadCloud, FileJson, Wrench,
  CheckCircle2, Activity, GitBranch, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { shortcutStore } from '@/lib/store';
import { getSubjectId } from '@/lib/subject';
import { useImportStrategy } from '@/lib/import-strategy';
import { ImportFlow } from '@/components/ImportFlow';
import { ShortcutActionCard } from '@/components/ShortcutActionCard';

/** Try to parse uploaded file as JSON plist, XML plist (text), or show an error. */
async function parseShortcutFile(file: File): Promise<ShortcutPlist | null> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // Detect binary plist magic "bplist"
  const isBinary =
    bytes[0] === 0x62 &&
    bytes[1] === 0x70 &&
    bytes[2] === 0x6c &&
    bytes[3] === 0x69 &&
    bytes[4] === 0x73 &&
    bytes[5] === 0x74;

  if (isBinary) {
    throw new Error(
      "Binary .shortcut files can't be parsed directly in the browser. " +
        'Please export your shortcut as JSON: open Shortcuts → share → "Export" → choose JSON format, then upload that file.',
    );
  }

  const text = new TextDecoder('utf-8').decode(bytes);

  // Try JSON first
  try {
    return JSON.parse(text) as ShortcutPlist;
  } catch {
    // Not JSON — try XML plist using the plist package
  }

  try {
    const plist = await import('plist');
    // plist v5 uses named exports: plist.parse()
    const parse = (plist as unknown as { parse: (s: string) => unknown }).parse ?? (plist as { default?: { parse: (s: string) => unknown } }).default?.parse;
    if (!parse) throw new Error('plist module did not export a parse function.');
    const parsed = parse(text);
    // Apple's XML plists for Shortcuts have WFWorkflowActions at the top level
    if (parsed && typeof parsed === 'object' && 'WFWorkflowActions' in (parsed as object)) {
      return parsed as ShortcutPlist;
    }
    throw new Error('Parsed plist does not look like a Shortcut file (missing WFWorkflowActions).');
  } catch (xmlErr) {
    if (xmlErr instanceof Error && xmlErr.message.startsWith('Parsed plist')) throw xmlErr;
    throw new Error('Could not parse the file as JSON or XML plist. ' + (xmlErr as Error).message);
  }
}

export function Validate() {
  const [, setLocation] = useLocation();

  /**
   * Captured once, at mount: the shortcut the user just generated, if any.
   *
   * Prefilling it saves a copy-paste, but the real reason to keep the run id is
   * attribution — a repair is only a learning example if it can be tied to the
   * generation that needed repairing. The id is used only while the textarea
   * still matches byte-for-byte what the run produced, so a hand-edited or
   * hand-pasted shortcut is never grafted onto someone's earlier run.
   */
  const [prefill] = useState(() => {
    const existing = shortcutStore.get();
    const runId = shortcutStore.getRunId();
    if (!existing || !runId) return null;
    return { json: JSON.stringify(existing, null, 2), runId };
  });

  const [inputJson, setInputJson] = useState(prefill?.json ?? '');
  const [parsedShortcut, setParsedShortcut] = useState<ShortcutPlist | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [repairedFileId, setRepairedFileId] = useState<string | null>(null);
  const [linkedRunId, setLinkedRunId] = useState<string | null>(null);

  const validate = useValidateShortcut();
  const explain = useExplainShortcut();
  const repair = useRepairShortcut();
  const diagnose = useDiagnoseShortcut();
  const storeFile = useStoreShortcutFile();

  const fileUrl = repairedFileId ? getGetShortcutFileUrl(repairedFileId) : undefined;
  const imp = useImportStrategy(fileUrl);

  const runAnalysis = (parsed: ShortcutPlist, runId: string | null = null) => {
    setParsedShortcut(parsed);
    setParseError(null);
    setRepairedFileId(null);
    setLinkedRunId(runId);
    validate.mutate({ data: { shortcut: parsed } });
    explain.mutate({ data: { shortcut: parsed } });
    diagnose.mutate({ data: { shortcut: parsed } });
    shortcutStore.set(parsed, runId);
  };

  const handleParseAndValidate = () => {
    setParseError(null);
    try {
      const parsed = JSON.parse(inputJson) as ShortcutPlist;
      // Only claim the run when the text is still exactly what it produced.
      runAnalysis(parsed, prefill && prefill.json === inputJson ? prefill.runId : null);
    } catch {
      setParseError('Invalid JSON. Please paste a valid Shortcut plist JSON object.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    try {
      const parsed = await parseShortcutFile(file);
      if (parsed) {
        setInputJson(JSON.stringify(parsed, null, 2));
        runAnalysis(parsed);
      }
    } catch (err) {
      setParseError((err as Error).message);
    }
  };

  const handleRepair = () => {
    if (!parsedShortcut || !validate.data?.findings) return;
    repair.mutate(
      {
        data: {
          shortcut: parsedShortcut,
          findings: validate.data.findings,
          // Lets the server measure this repair, and — with consent — attach it
          // to the run being repaired. Without a grant on file it is looked up
          // and discarded, exactly as on generate.
          subject: getSubjectId(),
          ...(linkedRunId ? { runId: linkedRunId } : {}),
        },
      },
      {
        onSuccess: (data) => {
          const repaired = data.shortcut;
          setParsedShortcut(repaired);
          setInputJson(JSON.stringify(repaired, null, 2));
          // Repairing does not start a new run, so the association survives and
          // a second repair still attaches to the same example.
          runAnalysis(repaired, linkedRunId);
          // Store the repaired shortcut so we can offer import
          storeFile.mutate(
            { data: { shortcut: repaired } },
            { onSuccess: (stored) => setRepairedFileId(stored.id) },
          );
        },
      },
    );
  };

  const hasIssues = (validate.data?.findings?.length ?? 0) > 0;
  const isClean = validate.data && validate.data.findings.length === 0;

  return (
    <div className="p-4 pt-8 pb-24 space-y-8 max-w-2xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-3 text-center mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-medium tracking-wide uppercase">
          <ShieldCheck className="w-3 h-3" />
          Trust Layer
        </div>
        <h1 className="text-4xl md:text-5xl font-serif font-medium tracking-tight text-foreground">
          Validate
        </h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          Audit any shortcut for schema correctness, iOS compatibility, data flow, and runtime behaviour.
        </p>
      </div>

      {/* Input area */}
      {!parsedShortcut && (
        <Card className="border border-dashed border-card-border bg-card/50 shadow-[var(--shadow-sm)]">
          <CardContent className="p-6 flex flex-col items-center space-y-4 text-center">
            <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-2 border border-primary/20">
              <FileJson className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h3 className="font-semibold text-lg font-serif">Paste JSON or Upload File</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Paste your shortcut's JSON, or upload a <strong>.shortcut</strong> or <strong>.json</strong> file to analyse it.
                Binary plist files require JSON export first.
              </p>
            </div>

            <Textarea
              data-testid="input-shortcut-json"
              placeholder='{"WFWorkflowActions": [...]}'
              className="min-h-[150px] font-mono text-xs resize-none bg-background/50 border-input focus-visible:ring-1 focus-visible:ring-ring mt-4 w-full"
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
            />

            {parseError && (
              <Alert variant="destructive" className="border-destructive/30 bg-destructive/10 w-full text-left">
                <AlertCircle className="w-4 h-4" />
                <AlertTitle>Parse error</AlertTitle>
                <AlertDescription className="text-xs">{parseError}</AlertDescription>
              </Alert>
            )}

            <div className="flex w-full gap-3 mt-2">
              <div className="relative flex-1">
                <input
                  data-testid="input-file-upload"
                  type="file"
                  accept=".shortcut,.json,.txt"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Button variant="outline" className="w-full h-12 border-border hover:bg-elevate-1 pointer-events-none" type="button">
                  <UploadCloud className="w-4 h-4 mr-2" />
                  Upload File
                </Button>
              </div>
              <Button
                data-testid="button-validate"
                className="flex-1 h-12 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleParseAndValidate}
                disabled={!inputJson.trim()}
              >
                <ShieldCheck className="w-4 h-4 mr-2" />
                Validate
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {(validate.isPending || diagnose.isPending) && (
        <div className="flex flex-col items-center justify-center py-12 space-y-4 text-muted-foreground animate-pulse">
          <ShieldCheck className="w-12 h-12 animate-bounce" />
          <p>Running schema, data-flow, and compatibility analysis…</p>
        </div>
      )}

      {/* Results */}
      {parsedShortcut && validate.data && (
        <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-serif font-medium tracking-tight">Analysis Report</h2>
            <Button
              variant="ghost"
              size="sm"
              data-testid="button-new-analysis"
              onClick={() => {
                setParsedShortcut(null);
                setInputJson('');
                setParseError(null);
                setRepairedFileId(null);
                validate.reset();
                explain.reset();
                diagnose.reset();
                repair.reset();
                imp.reset();
              }}
            >
              New analysis
            </Button>
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'iOS', value: validate.data.minimumIosVersion },
              { label: 'Actions', value: parsedShortcut.WFWorkflowActions?.length ?? 0 },
              { label: 'Permissions', value: validate.data.requiredPermissions.length },
              {
                label: 'Issues',
                value: validate.data.findings.length,
                accent: hasIssues ? 'text-destructive' : 'text-primary',
              },
            ].map(({ label, value, accent }) => (
              <Card key={label} className="border-card-border bg-card/60">
                <CardContent className="p-4 text-center">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className={cn('text-xl font-bold text-foreground mt-1', accent ?? '')}>{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* All-clear */}
          {isClean && (
            <Alert className="border border-primary/20 bg-primary/5 text-primary">
              <CheckCircle2 className="w-4 h-4" />
              <AlertTitle>All checks passed</AlertTitle>
              <AlertDescription>
                No schema or compatibility issues found. AI observations are probabilistic — always test on your target device.
              </AlertDescription>
            </Alert>
          )}

          {/* Findings + repair */}
          {hasIssues && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-serif font-medium">Findings</h3>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-auto-repair"
                  onClick={handleRepair}
                  disabled={repair.isPending}
                  className="border-border"
                >
                  <Wrench className="w-4 h-4 mr-2" />
                  {repair.isPending ? 'Repairing…' : 'Auto-repair'}
                </Button>
              </div>

              {/* Legend */}
              <div className="flex gap-3 text-xs text-muted-foreground px-1 flex-wrap">
                <span className="flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-orange-400" />
                  <span className="font-semibold text-orange-400">Compatibility issue</span> — definitive schema rule
                </span>
                <span className="flex items-center gap-1">
                  <Info className="w-3 h-3 text-amber-400" />
                  <span className="font-semibold text-amber-400">AI analysis</span> — probabilistic, not guaranteed
                </span>
              </div>

              {validate.data.findings.map((f, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-xl border p-3 flex items-start gap-3 text-sm',
                    f.severity === 'error'
                      ? 'border-destructive/30 bg-destructive/10'
                      : f.severity === 'warning'
                        ? 'border-orange-500/30 bg-orange-500/10'
                        : 'border-border bg-secondary/20',
                  )}
                  data-testid={`finding-${i}`}
                >
                  {f.severity === 'error' ? (
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                  ) : f.severity === 'warning' ? (
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-orange-400" />
                  ) : (
                    <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1">
                    <p className="font-semibold flex flex-wrap items-center gap-2 text-foreground">
                      {f.source === 'schema' ? (
                        <Badge variant="outline" className="text-[10px] h-5 border-orange-500/40 text-orange-400">
                          Compatibility issue
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-5 border-amber-500/40 text-amber-400">
                          AI analysis
                        </Badge>
                      )}
                      {f.actionIndex !== undefined && f.actionIndex >= 0 && (
                        <Badge variant="outline" className="text-[10px] h-5">Step {f.actionIndex + 1}</Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{f.message}</p>
                    {f.suggestion && (
                      <p className="text-xs font-medium mt-1 text-foreground/70">→ {f.suggestion}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Tabs: Trace / Data Flow / Explain */}
          <Tabs defaultValue="trace" className="w-full">
            <TabsList className="grid grid-cols-3 bg-muted border border-border">
              <TabsTrigger value="trace" className="data-[state=active]:bg-card data-[state=active]:text-foreground">
                <Activity className="w-4 h-4 mr-2" />
                Trace
              </TabsTrigger>
              <TabsTrigger value="dataflow" className="data-[state=active]:bg-card data-[state=active]:text-foreground">
                <GitBranch className="w-4 h-4 mr-2" />
                Data Flow
              </TabsTrigger>
              <TabsTrigger value="explain" className="data-[state=active]:bg-card data-[state=active]:text-foreground">
                <Info className="w-4 h-4 mr-2" />
                Explain
              </TabsTrigger>
            </TabsList>

            <TabsContent value="trace" className="space-y-3 mt-4">
              {validate.data.executionTrace.map((t, i) => {
                const stepFindings = validate.data.findings.filter(f => f.actionIndex === t.step);
                return (
                  <ShortcutActionCard
                    key={i}
                    index={t.step + 1}
                    displayName={t.action}
                    explanation={t.notes.join(' · ')}
                    findings={stepFindings}
                    animationDelay={i * 40}
                  />
                );
              })}
            </TabsContent>

            <TabsContent value="dataflow" className="mt-4">
              <Card className="border-card-border bg-card/40">
                <CardContent className="p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-secondary/30 text-center">
                      <p className="text-xs text-muted-foreground uppercase">Produced</p>
                      <p className="text-2xl font-bold text-foreground">{validate.data.dataFlowSummary.producedVariables}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-secondary/30 text-center">
                      <p className="text-xs text-muted-foreground uppercase">Consumed</p>
                      <p className="text-2xl font-bold text-foreground">{validate.data.dataFlowSummary.consumedVariables}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Unbound inputs</span>
                    <Badge variant={validate.data.dataFlowSummary.unboundInputs > 0 ? 'destructive' : 'outline'}>
                      {validate.data.dataFlowSummary.unboundInputs}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Device features required</span>
                    <span className="text-foreground text-xs">
                      {validate.data.requiredDeviceFeatures.length > 0
                        ? validate.data.requiredDeviceFeatures.join(', ')
                        : 'None'}
                    </span>
                  </div>
                  {validate.data.dataFlowSummary.unreachableSteps.length > 0 && (
                    <Alert className="border-orange-500/30 bg-orange-500/10 text-orange-400">
                      <AlertTriangle className="w-4 h-4" />
                      <AlertTitle>Potentially unreachable steps</AlertTitle>
                      <AlertDescription>
                        Steps {validate.data.dataFlowSummary.unreachableSteps.map((s) => s + 1).join(', ')} may not run due to control flow grouping.
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="explain" className="mt-4 space-y-3">
              {explain.data?.summary && (
                <Card className="border-card-border bg-card/40">
                  <CardContent className="p-4">
                    <p className="text-sm text-foreground leading-relaxed">{explain.data.summary}</p>
                    {explain.data.dataFlow && (
                      <p className="text-xs text-muted-foreground mt-3">{explain.data.dataFlow}</p>
                    )}
                    {explain.data.compatibility && (
                      <p className="text-xs text-muted-foreground mt-1">{explain.data.compatibility}</p>
                    )}
                  </CardContent>
                </Card>
              )}
              {explain.data?.steps.map((step, i) => (
                <ShortcutActionCard
                  key={i}
                  index={i + 1}
                  displayName={step.displayName}
                  explanation={step.explanation}
                  parameterSummary={step.parameterSummary}
                  animationDelay={i * 40}
                />
              ))}
            </TabsContent>
          </Tabs>

          {/* Repair result + Re-import */}
          {repair.data && (
            <Card className="border border-primary/20 bg-primary/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-serif flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-primary" />
                  Repair applied
                </CardTitle>
                <CardDescription>
                  {repair.data.changelog.length} change{repair.data.changelog.length !== 1 ? 's' : ''} made
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {repair.data.changelog.map((c, i) => (
                  <div key={i} className="text-sm flex items-start gap-2">
                    <Badge variant="outline" className="text-[10px] h-5 shrink-0">{c.changeType}</Badge>
                    <span className="text-muted-foreground">{c.description}</span>
                  </div>
                ))}
                {repair.data.unresolved && repair.data.unresolved.length > 0 && (
                  <div className="mt-2 p-2 rounded bg-destructive/10 text-xs text-destructive-foreground">
                    Unresolved: {repair.data.unresolved.join('; ')}
                  </div>
                )}
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                {repairedFileId && (
                  <Button
                    className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                    onClick={imp.startImport}
                    data-testid="button-reimport"
                  >
                    Import repaired shortcut
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="w-full border-border"
                  onClick={() => setLocation('/builder')}
                >
                  Open in Builder
                </Button>
              </CardFooter>
            </Card>
          )}
        </div>
      )}

      {/* Import flow dialog */}
      <ImportFlow imp={imp} onNavigateToBuilder={() => setLocation('/builder')} />
    </div>
  );
}

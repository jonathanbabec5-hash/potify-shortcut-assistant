import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConsentSettings } from '@/components/ConsentSettings';
import { AlertTriangle, Shield, Wand2, Blocks, Activity, GitBranch, HelpCircle, ExternalLink, Info } from 'lucide-react';

export function About() {
  return (
    <div className="p-4 pt-8 pb-24 space-y-8 max-w-2xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-3 text-center mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/20 bg-accent/5 text-accent text-xs font-medium tracking-wide uppercase">
          <Shield className="w-3 h-3" />
          About the Studio
        </div>
        <h1 className="text-4xl md:text-5xl font-serif font-medium tracking-tight text-foreground">
          Shortcut Studio
        </h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          A trust layer for iOS Shortcuts power users, built in the POTIFY design language.
        </p>
      </div>

      <div className="space-y-6">
        {/* Placed first deliberately: this is the only control that grants or
            withdraws data collection, and a consent control buried below ten
            cards is not one a person can meaningfully exercise. */}
        <ConsentSettings />

        {/* Mission */}
        <Card className="border border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-serif text-xl">
              <Shield className="w-5 h-5 text-primary" />
              Our Mission
            </CardTitle>
          </CardHeader>
          <CardContent className="text-foreground/90 space-y-4">
            <p>
              POTIFY Shortcut Studio is <strong>not a replacement</strong> for the native Apple Shortcuts app.
              It is a companion and trust layer: generate, validate, explain, debug, and repair shortcuts
              with confidence before any file touches your device.
            </p>
            <p>
              By catching problems <em>before</em> you import them, we save you time and prevent unexpected
              behaviour on your iPhone, iPad, or Mac.
            </p>
          </CardContent>
        </Card>

        {/* Feature cards */}
        <div className="grid sm:grid-cols-2 gap-4">
          <Card className="border border-card-border bg-card/40 shadow-[var(--shadow-sm)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 font-serif">
                <Wand2 className="w-4 h-4 text-primary" />
                Natural Generation
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Describe what you want to automate in plain English. A deterministic planner first turns
              your intent into a structured plan, then a language model refines it into a real Shortcut file.
            </CardContent>
          </Card>

          <Card className="border border-card-border bg-card/40 shadow-[var(--shadow-sm)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 font-serif">
                <AlertTriangle className="w-4 h-4 text-orange-400" />
                Validation & Repair
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              We separate definitive schema compatibility errors from AI-based observations. If a shortcut
              is broken, our auto-repair engine attempts to fix it while preserving intent.
            </CardContent>
          </Card>

          <Card className="border border-card-border bg-card/40 shadow-[var(--shadow-sm)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 font-serif">
                <GitBranch className="w-4 h-4 text-primary" />
                Data Flow & Diagnostics
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              We trace produced and consumed variables, detect unreachable steps, and surface required
              device features so you know exactly what will run.
            </CardContent>
          </Card>

          <Card className="border border-card-border bg-card/40 shadow-[var(--shadow-sm)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 font-serif">
                <HelpCircle className="w-4 h-4 text-primary" />
                Uncertainty & Alternatives
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              When intent is ambiguous, the studio asks clarifying questions and proposes alternative
              valid plans — so you stay in control.
            </CardContent>
          </Card>

          <Card className="border border-card-border bg-card/40 sm:col-span-2 shadow-[var(--shadow-sm)]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 font-serif">
                <Blocks className="w-4 h-4 text-primary" />
                Builder
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              A streamlined, visual way to assemble shortcuts. Add actions from our curated catalog,
              reorder them, restore deleted actions, see live diagnostics, and get AI-suggested next
              steps based on your current workflow.
            </CardContent>
          </Card>
        </div>

        {/* AI vs schema distinction */}
        <Card className="border border-amber-500/20 bg-amber-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-serif text-amber-400">
              <Info className="w-4 h-4" />
              Understanding Findings
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>
              This app separates two types of analysis, and you should treat them differently:
            </p>
            <div className="space-y-2">
              <div className="p-3 rounded-lg border border-orange-500/20 bg-orange-500/8">
                <p className="font-semibold text-orange-400 mb-1">Compatibility issue (orange)</p>
                <p>A <strong>definitive schema rule</strong>: the action identifier is unknown, a required
                parameter is missing, or an iOS version minimum is not met. These are deterministic — if
                this badge appears, the shortcut is guaranteed to fail on that point.</p>
              </div>
              <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/8">
                <p className="font-semibold text-amber-400 mb-1">AI analysis (yellow)</p>
                <p>An <strong>AI observation</strong>: a language model has noted something that looks
                unusual or potentially problematic. These are probabilistic — they may be false positives
                and are not guaranteed errors. Always test on your target device.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Privacy & transparency */}
        <Card className="border border-accent/20 bg-accent/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-serif text-accent-foreground">
              <Activity className="w-4 h-4" />
              Privacy & Source Traceability
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>Shortcuts are generated in memory and stored only for 15 minutes so you can download them. No shortcuts are persisted long-term, and we do not sign files as Apple Inc.</p>
            <p>Every action is mapped to a documented iOS Shortcuts identifier. Every generated plan can be inspected before export.</p>
          </CardContent>
        </Card>

        {/* Transparency note */}
        <Card className="border border-card-border bg-card/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-serif">
              <Info className="w-4 h-4 text-muted-foreground" />
              Data Currency Notice
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              <strong className="text-foreground">iOS version compatibility data is maintained manually</strong> and
              may lag behind Apple's latest releases. New actions introduced in iOS 27 or later may not yet
              be in our catalog and will be flagged as "unrecognised action" rather than assumed valid.
            </p>
            <p>
              Our catalog is based on community-maintained documentation, not Apple's official (unpublished) action list.
              Validation results are best-effort and should always be confirmed by testing on a real device.
            </p>
          </CardContent>
        </Card>

        {/* Sources */}
        <Card className="border border-card-border bg-card/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 font-serif">
              Community Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>This app's action catalog and plist schema understanding are derived from community research. We are grateful to:</p>
            <ul className="space-y-2">
              {[
                { name: 'sebj / iOS-Shortcuts-Reference', url: 'https://github.com/sebj/iOS-Shortcuts-Reference', note: 'most authoritative community plist format reference' },
                { name: 'zachary7829 / Shortcuts file format', url: 'https://zachary7829.github.io/blog/shortcuts/fileformat', note: 'top-level keys, action structure, import questions' },
                { name: 'joshfarrant / shortcuts-js', url: 'https://github.com/joshfarrant/shortcuts-js', note: 'TypeScript typings for action identifiers' },
                { name: 'drewburchfield / shortcuts-toolkit', url: 'https://github.com/drewburchfield/shortcuts-toolkit', note: 'programmatic plist generation reference' },
                { name: 'RoutineHub', url: 'https://routinehub.co', note: 'community shortcut library and sharing platform' },
              ].map(({ name, url, note }) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:text-accent/80 flex items-center gap-1 font-medium"
                  >
                    {name}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <span className="text-muted-foreground/70 text-xs"> — {note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* RoutineHub CTA */}
        <Card className="border border-card-border bg-card/40">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground mb-3">
              Looking for community-made shortcuts to validate or inspect?
            </p>
            <a
              href="https://routinehub.co"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
              data-testid="link-routinehub"
            >
              Browse RoutineHub
              <ExternalLink className="w-4 h-4" />
            </a>
          </CardContent>
        </Card>

        {/* Legal footer */}
        <div className="pt-8 text-center text-xs text-muted-foreground space-y-1">
          <p>POTIFY Shortcut Studio is an independent tool, not affiliated with or endorsed by Apple Inc.</p>
          <p>"Shortcuts", "iOS", "iPhone", "iPad", and "Mac" are trademarks of Apple Inc.</p>
        </div>
      </div>
    </div>
  );
}

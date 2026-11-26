# Complete file tree

The public developer edition contains 391 files: 382 reviewed source files and 9 release documentation/example files.

```text
.
├── .gitignore
├── .npmrc
├── README.md
├── artifacts/
│   ├── api-server/
│   │   ├── build.mjs
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── index.ts
│   │   │   ├── json.d.ts
│   │   │   ├── lib/
│   │   │   │   ├── .gitkeep
│   │   │   │   ├── learning/
│   │   │   │   │   ├── active-learning.ts
│   │   │   │   │   ├── boot.ts
│   │   │   │   │   ├── clustering.ts
│   │   │   │   │   ├── collect-repair.test.ts
│   │   │   │   │   ├── collect-repair.ts
│   │   │   │   │   ├── collect-run.ts
│   │   │   │   │   ├── collection.test.ts
│   │   │   │   │   ├── collection.ts
│   │   │   │   │   ├── consent.test.ts
│   │   │   │   │   ├── consent.ts
│   │   │   │   │   ├── cost.test.ts
│   │   │   │   │   ├── cost.ts
│   │   │   │   │   ├── eval-coverage.ts
│   │   │   │   │   ├── eval-holdout.test.ts
│   │   │   │   │   ├── eval-holdout.ts
│   │   │   │   │   ├── eval-set.test.ts
│   │   │   │   │   ├── eval-set.ts
│   │   │   │   │   ├── governance.test.ts
│   │   │   │   │   ├── governance.ts
│   │   │   │   │   ├── maturity.ts
│   │   │   │   │   ├── outcomes.test.ts
│   │   │   │   │   ├── outcomes.ts
│   │   │   │   │   ├── placeholder-families.ts
│   │   │   │   │   ├── privacy.test.ts
│   │   │   │   │   ├── privacy.ts
│   │   │   │   │   ├── records.ts
│   │   │   │   │   ├── retention.test.ts
│   │   │   │   │   ├── retention.ts
│   │   │   │   │   ├── screening.test.ts
│   │   │   │   │   ├── screening.ts
│   │   │   │   │   └── training/
│   │   │   │   │       ├── adapter-block.ts
│   │   │   │   │       ├── batch.ts
│   │   │   │   │       ├── benchmark.test.ts
│   │   │   │   │       ├── benchmark.ts
│   │   │   │   │       ├── candidate.test.ts
│   │   │   │   │       ├── candidate.ts
│   │   │   │   │       ├── index.ts
│   │   │   │   │       ├── loop.ts
│   │   │   │   │       └── training-isolation.test.ts
│   │   │   │   ├── logger.ts
│   │   │   │   └── shortcuts/
│   │   │   │       ├── adapter.ts
│   │   │   │       ├── catalog.ts
│   │   │   │       ├── compatibility.ts
│   │   │   │       ├── completion.test.ts
│   │   │   │       ├── completion.ts
│   │   │   │       ├── dataflow.test.ts
│   │   │   │       ├── dataflow.ts
│   │   │   │       ├── llm-prompt-identity.test.ts
│   │   │   │       ├── llm-schemas.ts
│   │   │   │       ├── llm.ts
│   │   │   │       ├── model-config-metering.test.ts
│   │   │   │       ├── model-config.temperature.test.ts
│   │   │   │       ├── model-config.test.ts
│   │   │   │       ├── model-config.ts
│   │   │   │       ├── pipeline-types.ts
│   │   │   │       ├── pipeline.test.ts
│   │   │   │       ├── pipeline.ts
│   │   │   │       ├── planner.test.ts
│   │   │   │       ├── planner.ts
│   │   │   │       ├── plist.ts
│   │   │   │       ├── refusal.ts
│   │   │   │       ├── regression.ts
│   │   │   │       ├── schema-retrieval.ts
│   │   │   │       ├── store.ts
│   │   │   │       ├── types.ts
│   │   │   │       ├── validation.test.ts
│   │   │   │       └── validation.ts
│   │   │   ├── middlewares/
│   │   │   │   └── .gitkeep
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── learning.ts
│   │   │   │   └── shortcuts.ts
│   │   │   └── scripts/
│   │   │       ├── retention.ts
│   │   │       └── train.ts
│   │   └── tsconfig.json
│   ├── mockup-sandbox/
│   │   ├── components.json
│   │   ├── index.html
│   │   ├── mockupPreviewPlugin.ts
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── .generated/
│   │   │   │   └── mockup-components.ts
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   └── ui/
│   │   │   │       ├── accordion.tsx
│   │   │   │       ├── alert-dialog.tsx
│   │   │   │       ├── alert.tsx
│   │   │   │       ├── aspect-ratio.tsx
│   │   │   │       ├── avatar.tsx
│   │   │   │       ├── badge.tsx
│   │   │   │       ├── breadcrumb.tsx
│   │   │   │       ├── button-group.tsx
│   │   │   │       ├── button.tsx
│   │   │   │       ├── calendar.tsx
│   │   │   │       ├── card.tsx
│   │   │   │       ├── carousel.tsx
│   │   │   │       ├── chart.tsx
│   │   │   │       ├── checkbox.tsx
│   │   │   │       ├── collapsible.tsx
│   │   │   │       ├── command.tsx
│   │   │   │       ├── context-menu.tsx
│   │   │   │       ├── dialog.tsx
│   │   │   │       ├── drawer.tsx
│   │   │   │       ├── dropdown-menu.tsx
│   │   │   │       ├── empty.tsx
│   │   │   │       ├── field.tsx
│   │   │   │       ├── form.tsx
│   │   │   │       ├── hover-card.tsx
│   │   │   │       ├── input-group.tsx
│   │   │   │       ├── input-otp.tsx
│   │   │   │       ├── input.tsx
│   │   │   │       ├── item.tsx
│   │   │   │       ├── kbd.tsx
│   │   │   │       ├── label.tsx
│   │   │   │       ├── menubar.tsx
│   │   │   │       ├── navigation-menu.tsx
│   │   │   │       ├── pagination.tsx
│   │   │   │       ├── popover.tsx
│   │   │   │       ├── progress.tsx
│   │   │   │       ├── radio-group.tsx
│   │   │   │       ├── resizable.tsx
│   │   │   │       ├── scroll-area.tsx
│   │   │   │       ├── select.tsx
│   │   │   │       ├── separator.tsx
│   │   │   │       ├── sheet.tsx
│   │   │   │       ├── sidebar.tsx
│   │   │   │       ├── skeleton.tsx
│   │   │   │       ├── slider.tsx
│   │   │   │       ├── sonner.tsx
│   │   │   │       ├── spinner.tsx
│   │   │   │       ├── switch.tsx
│   │   │   │       ├── table.tsx
│   │   │   │       ├── tabs.tsx
│   │   │   │       ├── textarea.tsx
│   │   │   │       ├── toast.tsx
│   │   │   │       ├── toaster.tsx
│   │   │   │       ├── toggle-group.tsx
│   │   │   │       ├── toggle.tsx
│   │   │   │       └── tooltip.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── use-mobile.tsx
│   │   │   │   └── use-toast.ts
│   │   │   ├── index.css
│   │   │   ├── lib/
│   │   │   │   └── utils.ts
│   │   │   └── main.tsx
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   └── shortcuts-assistant/
│       ├── components.json
│       ├── index.html
│       ├── package.json
│       ├── public/
│       │   ├── favicon.svg
│       │   ├── manifest.json
│       │   └── robots.txt
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── ConsentSettings.tsx
│       │   │   ├── ImportFlow.tsx
│       │   │   ├── ShortcutActionCard.tsx
│       │   │   ├── layout/
│       │   │   │   ├── AppShell.tsx
│       │   │   │   └── BottomNav.tsx
│       │   │   └── ui/
│       │   │       ├── accordion.tsx
│       │   │       ├── alert-dialog.tsx
│       │   │       ├── alert.tsx
│       │   │       ├── aspect-ratio.tsx
│       │   │       ├── avatar.tsx
│       │   │       ├── badge.tsx
│       │   │       ├── breadcrumb.tsx
│       │   │       ├── button-group.tsx
│       │   │       ├── button.tsx
│       │   │       ├── calendar.tsx
│       │   │       ├── card.tsx
│       │   │       ├── carousel.tsx
│       │   │       ├── chart.tsx
│       │   │       ├── checkbox.tsx
│       │   │       ├── collapsible.tsx
│       │   │       ├── command.tsx
│       │   │       ├── context-menu.tsx
│       │   │       ├── dialog.tsx
│       │   │       ├── drawer.tsx
│       │   │       ├── dropdown-menu.tsx
│       │   │       ├── empty.tsx
│       │   │       ├── field.tsx
│       │   │       ├── form.tsx
│       │   │       ├── hover-card.tsx
│       │   │       ├── input-group.tsx
│       │   │       ├── input-otp.tsx
│       │   │       ├── input.tsx
│       │   │       ├── item.tsx
│       │   │       ├── kbd.tsx
│       │   │       ├── label.tsx
│       │   │       ├── menubar.tsx
│       │   │       ├── navigation-menu.tsx
│       │   │       ├── pagination.tsx
│       │   │       ├── popover.tsx
│       │   │       ├── progress.tsx
│       │   │       ├── radio-group.tsx
│       │   │       ├── resizable.tsx
│       │   │       ├── scroll-area.tsx
│       │   │       ├── select.tsx
│       │   │       ├── separator.tsx
│       │   │       ├── sheet.tsx
│       │   │       ├── sidebar.tsx
│       │   │       ├── skeleton.tsx
│       │   │       ├── slider.tsx
│       │   │       ├── sonner.tsx
│       │   │       ├── spinner.tsx
│       │   │       ├── switch.tsx
│       │   │       ├── table.tsx
│       │   │       ├── tabs.tsx
│       │   │       ├── textarea.tsx
│       │   │       ├── toast.tsx
│       │   │       ├── toaster.tsx
│       │   │       ├── toggle-group.tsx
│       │   │       ├── toggle.tsx
│       │   │       └── tooltip.tsx
│       │   ├── hooks/
│       │   │   ├── use-mobile.tsx
│       │   │   └── use-toast.ts
│       │   ├── index.css
│       │   ├── lib/
│       │   │   ├── app-version.ts
│       │   │   ├── builder-logic.test.ts
│       │   │   ├── builder-logic.ts
│       │   │   ├── edit-journal.ts
│       │   │   ├── import-strategy.ts
│       │   │   ├── store.ts
│       │   │   ├── subject.ts
│       │   │   ├── use-run-feedback.ts
│       │   │   └── utils.ts
│       │   ├── main.tsx
│       │   ├── pages/
│       │   │   ├── About.tsx
│       │   │   ├── Builder.tsx
│       │   │   ├── Generate.tsx
│       │   │   ├── Validate.tsx
│       │   │   └── not-found.tsx
│       │   └── vite-env.d.ts
│       ├── tsconfig.json
│       └── vite.config.ts
├── docs/
│   ├── DEPENDENCIES.md
│   ├── DIRECTORY.md
│   ├── PILOT-MARKETING.md
│   ├── SOURCE-REVIEW.md
│   ├── THIRD-PARTY-NOTICES.md
│   └── WHITEPAPER.md
├── examples/
│   ├── README.md
│   └── synthetic-intents.json
├── lib/
│   ├── api-client-react/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── custom-fetch.ts
│   │   │   ├── generated/
│   │   │   │   ├── api.schemas.ts
│   │   │   │   └── api.ts
│   │   │   └── index.ts
│   │   └── tsconfig.json
│   ├── api-spec/
│   │   ├── openapi.yaml
│   │   ├── orval.config.ts
│   │   ├── package.json
│   │   ├── scripts/
│   │   │   └── fix-zod.js
│   │   └── shortcuts-catalog-v1.json
│   ├── api-zod/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── generated/
│   │   │   │   ├── api.ts
│   │   │   │   └── types/
│   │   │   │       ├── actionAppSpec.ts
│   │   │   │       ├── actionControlFlowSpec.ts
│   │   │   │       ├── actionControlFlowSpecGroupType.ts
│   │   │   │       ├── actionExplanation.ts
│   │   │   │       ├── actionParameterSpec.ts
│   │   │   │       ├── actionParameterSpecItems.ts
│   │   │   │       ├── actionParametersSpec.ts
│   │   │   │       ├── actionSuggestion.ts
│   │   │   │       ├── actionSuggestionParameters.ts
│   │   │   │       ├── actionVariableSpec.ts
│   │   │   │       ├── completionResult.ts
│   │   │   │       ├── completionStatus.ts
│   │   │   │       ├── consentInput.ts
│   │   │   │       ├── consentScopeOption.ts
│   │   │   │       ├── consentState.ts
│   │   │   │       ├── consentSubject.ts
│   │   │   │       ├── consentWithdrawal.ts
│   │   │   │       ├── deviceCompatibilitySpec.ts
│   │   │   │       ├── errorResponse.ts
│   │   │   │       ├── executionTraceStep.ts
│   │   │   │       ├── executionTraceStepStatus.ts
│   │   │   │       ├── failureClusterSummary.ts
│   │   │   │       ├── feedbackAck.ts
│   │   │   │       ├── getConsentParams.ts
│   │   │   │       ├── healthStatus.ts
│   │   │   │       ├── index.ts
│   │   │   │       ├── intentChecklistItem.ts
│   │   │   │       ├── intentChecklistItemType.ts
│   │   │   │       ├── learningInsights.ts
│   │   │   │       ├── learningPriority.ts
│   │   │   │       ├── learningRecordTotals.ts
│   │   │   │       ├── repairChange.ts
│   │   │   │       ├── repairChangeChangeType.ts
│   │   │   │       ├── shortcutAction.ts
│   │   │   │       ├── shortcutActionWFWorkflowActionClassArguments.ts
│   │   │   │       ├── shortcutActionWFWorkflowActionParameters.ts
│   │   │   │       ├── shortcutAlternative.ts
│   │   │   │       ├── shortcutClarifyInput.ts
│   │   │   │       ├── shortcutClarifyQuestion.ts
│   │   │   │       ├── shortcutClarifyQuestionType.ts
│   │   │   │       ├── shortcutClarifyResponse.ts
│   │   │   │       ├── shortcutDiagnoseInput.ts
│   │   │   │       ├── shortcutDiagnoseResponse.ts
│   │   │   │       ├── shortcutDiagnoseTrace.ts
│   │   │   │       ├── shortcutDiagnoseTraceStatus.ts
│   │   │   │       ├── shortcutExplainInput.ts
│   │   │   │       ├── shortcutExplainResponse.ts
│   │   │   │       ├── shortcutFeedbackInput.ts
│   │   │   │       ├── shortcutFileInput.ts
│   │   │   │       ├── shortcutFileStored.ts
│   │   │   │       ├── shortcutGenerateInput.ts
│   │   │   │       ├── shortcutGenerateInputSlots.ts
│   │   │   │       ├── shortcutGenerateResponse.ts
│   │   │   │       ├── shortcutPlanAlternative.ts
│   │   │   │       ├── shortcutPlanInput.ts
│   │   │   │       ├── shortcutPlanInputSlots.ts
│   │   │   │       ├── shortcutPlanResponse.ts
│   │   │   │       ├── shortcutPlanResponseConfidence.ts
│   │   │   │       ├── shortcutPlanSlot.ts
│   │   │   │       ├── shortcutPlanSlotSource.ts
│   │   │   │       ├── shortcutPlanSlotType.ts
│   │   │   │       ├── shortcutPlanStep.ts
│   │   │   │       ├── shortcutPlanStepParameterBindingsItem.ts
│   │   │   │       ├── shortcutPlist.ts
│   │   │   │       ├── shortcutPlistWFWorkflowIcon.ts
│   │   │   │       ├── shortcutPlistWFWorkflowImportQuestionsItem.ts
│   │   │   │       ├── shortcutRepairInput.ts
│   │   │   │       ├── shortcutRepairResponse.ts
│   │   │   │       ├── shortcutSuggestInput.ts
│   │   │   │       ├── shortcutSuggestResponse.ts
│   │   │   │       ├── shortcutValidateInput.ts
│   │   │   │       ├── shortcutValidateResponse.ts
│   │   │   │       ├── shortcutValidateResponseDataFlowSummary.ts
│   │   │   │       ├── shortcutsActionCatalogEntry.ts
│   │   │   │       ├── shortcutsActionsCatalog.ts
│   │   │   │       ├── userEditEvent.ts
│   │   │   │       ├── userEditEventOp.ts
│   │   │   │       ├── validationFailureResponse.ts
│   │   │   │       ├── validationFinding.ts
│   │   │   │       ├── validationFindingSeverity.ts
│   │   │   │       └── validationFindingSource.ts
│   │   │   └── index.ts
│   │   └── tsconfig.json
│   ├── db/
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── schema/
│   │   │       ├── conversations.ts
│   │   │       ├── index.ts
│   │   │       ├── learning.ts
│   │   │       └── messages.ts
│   │   └── tsconfig.json
│   ├── integrations/
│   │   └── openai_ai_integrations/
│   │       └── src/
│   │           ├── client/
│   │           │   └── audio/
│   │           │       ├── audio-playback-worklet.js
│   │           │       ├── audio-utils.ts
│   │           │       ├── index.ts
│   │           │       ├── useAudioPlayback.ts
│   │           │       └── useVoiceRecorder.ts
│   │           └── server/
│   │               ├── audio/
│   │               │   ├── client.ts
│   │               │   └── index.ts
│   │               ├── batch/
│   │               │   ├── index.ts
│   │               │   └── utils.ts
│   │               └── image/
│   │                   ├── client.ts
│   │                   └── index.ts
│   ├── integrations-openai-ai-react/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── audio/
│   │   │   │   ├── audio-playback-worklet.js
│   │   │   │   ├── audio-utils.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── useAudioPlayback.ts
│   │   │   │   ├── useVoiceRecorder.ts
│   │   │   │   └── useVoiceStream.ts
│   │   │   └── index.ts
│   │   └── tsconfig.json
│   └── integrations-openai-ai-server/
│       ├── package.json
│       ├── src/
│       │   ├── audio/
│       │   │   ├── client.ts
│       │   │   └── index.ts
│       │   ├── batch/
│       │   │   ├── index.ts
│       │   │   └── utils.ts
│       │   ├── client.ts
│       │   ├── image/
│       │   │   ├── client.ts
│       │   │   └── index.ts
│       │   └── index.ts
│       └── tsconfig.json
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── scripts/
│   ├── package.json
│   ├── post-merge.sh
│   ├── src/
│   │   └── hello.ts
│   └── tsconfig.json
├── tsconfig.base.json
└── tsconfig.json
```

// JSON Schemas for OpenAI structured output (response_format: { type: "json_schema" }).
// These are intentionally narrow: they enforce the response shape the backend expects
// so the LLM cannot omit required fields or return free text.

export const generateShortcutSchema = {
  name: "generateShortcut",
  strict: false,
  schema: {
    type: "object",
    properties: {
      shortcut: {
        type: "object",
        properties: {
          WFWorkflowClientVersion: { type: "string" },
          WFWorkflowClientRelease: { type: "string" },
          WFWorkflowMinimumClientVersion: { type: "integer" },
          WFWorkflowMinimumClientVersionString: { type: "string" },
          WFWorkflowName: { type: "string" },
          WFWorkflowIcon: { type: "object" },
          WFWorkflowTypes: { type: "array", items: { type: "string" } },
          WFWorkflowInputContentItemClasses: { type: "array", items: { type: "string" } },
          WFWorkflowImportQuestions: { type: "array", items: { type: "object" } },
          WFWorkflowActions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                WFWorkflowActionIdentifier: { type: "string" },
                WFWorkflowActionParameters: { type: "object" },
                UUID: { type: "string" },
                GroupingIdentifier: { type: "string" },
              },
              required: ["WFWorkflowActionIdentifier", "WFWorkflowActionParameters"],
              additionalProperties: true,
            },
          },
        },
        required: ["WFWorkflowActions"],
        additionalProperties: true,
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            actionIndex: { type: "integer" },
            identifier: { type: "string" },
            displayName: { type: "string" },
            explanation: { type: "string" },
            parameterSummary: { type: "string" },
          },
          required: ["actionIndex", "identifier", "displayName", "explanation", "parameterSummary"],
          additionalProperties: false,
        },
      },
      minimumIosVersion: { type: "string" },
      explanation: { type: "string" },
      uncertainty: { type: "array", items: { type: "string" } },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["label", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["shortcut", "actions", "minimumIosVersion", "explanation", "uncertainty", "alternatives"],
    additionalProperties: false,
  },
} as const;

export const explainShortcutSchema = {
  name: "explainShortcut",
  strict: false,
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            actionIndex: { type: "integer" },
            identifier: { type: "string" },
            displayName: { type: "string" },
            explanation: { type: "string" },
            parameterSummary: { type: "string" },
          },
          required: ["actionIndex", "identifier", "displayName", "explanation", "parameterSummary"],
          additionalProperties: false,
        },
      },
      summary: { type: "string" },
      dataFlow: { type: "string" },
      compatibility: { type: "string" },
    },
    required: ["steps", "summary", "dataFlow", "compatibility"],
    additionalProperties: false,
  },
} as const;

export const repairShortcutSchema = {
  name: "repairShortcut",
  strict: false,
  schema: {
    type: "object",
    properties: {
      shortcut: {
        type: "object",
        properties: {
          WFWorkflowClientVersion: { type: "string" },
          WFWorkflowClientRelease: { type: "string" },
          WFWorkflowMinimumClientVersion: { type: "integer" },
          WFWorkflowMinimumClientVersionString: { type: "string" },
          WFWorkflowName: { type: "string" },
          WFWorkflowIcon: { type: "object" },
          WFWorkflowTypes: { type: "array", items: { type: "string" } },
          WFWorkflowInputContentItemClasses: { type: "array", items: { type: "string" } },
          WFWorkflowImportQuestions: { type: "array", items: { type: "object" } },
          WFWorkflowActions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                WFWorkflowActionIdentifier: { type: "string" },
                WFWorkflowActionParameters: { type: "object" },
                UUID: { type: "string" },
                GroupingIdentifier: { type: "string" },
              },
              required: ["WFWorkflowActionIdentifier", "WFWorkflowActionParameters"],
              additionalProperties: true,
            },
          },
        },
        required: ["WFWorkflowActions"],
        additionalProperties: true,
      },
      changelog: {
        type: "array",
        items: {
          type: "object",
          properties: {
            actionIndex: { type: "integer" },
            changeType: { type: "string", enum: ["modified", "removed", "added"] },
            description: { type: "string" },
          },
          required: ["actionIndex", "changeType", "description"],
          additionalProperties: false,
        },
      },
      unresolved: { type: "array", items: { type: "string" } },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["label", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["shortcut", "changelog", "unresolved", "alternatives"],
    additionalProperties: false,
  },
} as const;

export const suggestNextActionsSchema = {
  name: "suggestNextActions",
  strict: false,
  schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            identifier: { type: "string" },
            displayName: { type: "string" },
            rationale: { type: "string" },
            parameters: { type: "object" },
          },
          required: ["identifier", "displayName", "rationale", "parameters"],
          additionalProperties: false,
        },
      },
    },
    required: ["suggestions"],
    additionalProperties: false,
  },
} as const;

// ── Pipeline schemas ──────────────────────────────────────────────────────────

export const extractChecklistSchema = {
  name: "extractChecklist",
  strict: false,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["condition", "action", "constraint"] },
            description: { type: "string" },
            requiredActions: { type: "array", items: { type: "string" } },
            operand: { type: "string" },
            operator: { type: "string" },
            threshold: { type: "string" },
            needsClarification: { type: "boolean" },
            externalDomain: { type: "boolean" },
          },
          required: ["id", "type", "description", "requiredActions"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

const irBlockSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["if", "repeat", "choose"] },
    conditionStepId: { type: "string" },
    thenSteps: { type: "array", items: { type: "string" } },
    elseSteps: { type: "array", items: { type: "string" } },
    nestedBlocks: { type: "array", items: { type: "object" } },
    checklistItemId: { type: "string" },
  },
  required: ["type", "conditionStepId", "thenSteps", "elseSteps", "nestedBlocks"],
  additionalProperties: true,
};

export const generateIRSchema = {
  name: "generateIR",
  strict: false,
  schema: {
    type: "object",
    properties: {
      goal: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            actionIdentifier: { type: "string" },
            parameterBindings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  valueType: { type: "string" },
                  value: {},
                  source: { type: "string", enum: ["literal", "variable", "user-input"] },
                  variableId: { type: "string" },
                },
                required: ["key", "valueType", "source"],
                additionalProperties: true,
              },
            },
            producesVariable: { type: "string" },
            justifiedByItemId: { type: "string" },
          },
          required: ["id", "actionIdentifier", "parameterBindings"],
          additionalProperties: true,
        },
      },
      variables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            producedByStep: { type: "string" },
          },
          required: ["id", "type", "producedByStep"],
          additionalProperties: false,
        },
      },
      controlFlow: { type: "array", items: irBlockSchema },
      satisfies: { type: "array", items: { type: "string" } },
      unsatisfiedItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["itemId", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["goal", "steps", "variables", "controlFlow", "satisfies"],
    additionalProperties: false,
  },
} as const;

export const semanticValidationSchema = {
  name: "semanticValidation",
  strict: false,
  schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["warning", "info"] },
            source: { type: "string", enum: ["ai"] },
            actionIndex: { type: "integer" },
            message: { type: "string" },
            suggestion: { type: "string" },
          },
          required: ["severity", "source", "message"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  },
} as const;

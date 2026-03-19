(function attachCommandUtils(globalScope) {
  function normalizeCommandText(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.?!]+$/g, "");
  }

  function stripWrappingQuotes(value) {
    const text = String(value || "").trim();
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function normalizeLocatorStrategy(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return "";
    }

    if (normalized === "data-testid" || normalized === "data testid" || normalized === "test id" || normalized === "testid") {
      return "data-testid";
    }
    if (normalized === "selector") {
      return "css";
    }
    if (normalized === "label") {
      return "text";
    }
    return normalized;
  }

  function trimTrailingControlNouns(value) {
    return String(value || "")
      .replace(/\b(button|btn|link|field|input|textbox|text box|dropdown|select|menu item|tab|icon|checkbox|radio)\b$/i, "")
      .trim();
  }

  function parseTargetLocatorHint(rawDescription) {
    const normalizedDescription = stripWrappingQuotes(rawDescription);
    const match = normalizedDescription.match(/^(.+?)\s+by\s+(text|label|id|name|css|selector|xpath|testid|data-testid)$/i);
    if (!match) {
      return {
        targetDescription: normalizedDescription,
        locatorHint: null
      };
    }

    const strategy = normalizeLocatorStrategy(match[2]);
    const locatorValue =
      strategy === "text"
        ? trimTrailingControlNouns(match[1])
        : stripWrappingQuotes(match[1]);

    return {
      targetDescription: stripWrappingQuotes(match[1]),
      locatorHint: {
        strategy,
        value: locatorValue || stripWrappingQuotes(match[1]),
        match: strategy === "text" ? "contains" : "equals"
      }
    };
  }

  function getLocatorStability(strategy) {
    if (strategy === "id" || strategy === "data-testid") {
      return "strong";
    }
    if (strategy === "name" || strategy === "text") {
      return "medium";
    }
    if (strategy === "css" || strategy === "xpath") {
      return "user_supplied";
    }
    return "natural_language";
  }

  function buildDescriptionTarget(description, locatorHint) {
    const normalizedDescription = stripWrappingQuotes(description);
    const primaryLocator = locatorHint
      ? {
          type: locatorHint.strategy,
          value: locatorHint.value,
          match: locatorHint.match,
          stability: getLocatorStability(locatorHint.strategy)
        }
      : {
          type: "description",
          value: normalizedDescription,
          stability: "natural_language"
        };

    const locatorCandidates = [primaryLocator];
    if (!locatorHint || primaryLocator.value !== normalizedDescription) {
      locatorCandidates.push({
        type: "description",
        value: normalizedDescription,
        stability: "natural_language"
      });
    }

    return {
      targetType: "description",
      description: normalizedDescription,
      locatorHint,
      tagName: "description",
      id: "",
      dataTestId: "",
      name: "",
      selector: "",
      xpath: "",
      primaryLocator,
      locatorCandidates,
      text: normalizedDescription
    };
  }

  function buildWaitHints(action, commandShape) {
    if (action === "navigate") {
      return {
        before: [],
        after: [
          {
            type: "url_matches",
            match: "equals",
            value: commandShape.destinationUrl,
            timeoutMs: 15000
          },
          {
            type: "document_ready_state",
            value: "complete",
            timeoutMs: 15000
          }
        ]
      };
    }

    if (action === "click") {
      return {
        before: [
          {
            type: "element_actionable",
            timeoutMs: 8000
          }
        ],
        after: [
          {
            type: "dom_settled",
            timeoutMs: 1000
          },
          {
            type: "optional_navigation",
            timeoutMs: 10000
          }
        ]
      };
    }

    return {
      before: [],
      after: []
    };
  }

  function parseNaturalLanguageCommand(rawCommand) {
    const cleaned = normalizeCommandText(rawCommand);
    if (!cleaned) {
      return null;
    }

    const patterns = [
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:page )?title(?: contains) (.+)$/i,
        assertionType: "document_title",
        comparison: "contains"
      },
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:page )?title(?: is| equals)? (.+)$/i,
        assertionType: "document_title",
        comparison: "equals"
      },
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:page )?title$/i,
        assertionType: "document_title",
        comparison: "equals"
      },
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:current )?url(?: contains) (.+)$/i,
        assertionType: "document_url",
        comparison: "contains"
      },
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:current )?url(?: is| equals)? (.+)$/i,
        assertionType: "document_url",
        comparison: "equals"
      },
      {
        regex: /^(?:validate|verify|check) (?:the )?(?:current )?url$/i,
        assertionType: "document_url",
        comparison: "equals"
      },
      {
        regex: /^(?:go to|open|navigate to) (https?:\/\/\S+)$/i,
        kind: "navigation"
      },
      {
        regex: /^(?:click|tap|press) (?:on )?(.+)$/i,
        kind: "click"
      },
      {
        regex: /^(?:enter|type|fill|input)\s+(.+?)\s+(?:into|in|for)\s+(.+)$/i,
        kind: "enter"
      },
      {
        regex: /^(?:validate|verify|check) (.+?) (?:is )?(visible|present)$/i,
        kind: "element_validation"
      }
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern.regex);
      if (match) {
        if (pattern.kind === "navigation") {
          return {
            kind: "navigation",
            rawCommand: cleaned,
            normalizedCommand: cleaned.toLowerCase(),
            destinationUrl: stripWrappingQuotes(match[1] || "")
          };
        }

        if (pattern.kind === "click") {
          const parsedTarget = parseTargetLocatorHint(match[1] || "");
          return {
            kind: "click",
            rawCommand: cleaned,
            normalizedCommand: cleaned.toLowerCase(),
            targetDescription: parsedTarget.targetDescription,
            locatorHint: parsedTarget.locatorHint
          };
        }

        if (pattern.kind === "enter") {
          const parsedTarget = parseTargetLocatorHint(match[2] || "");
          const inputValue = stripWrappingQuotes(match[1] || "");
          return {
            kind: "enter",
            rawCommand: cleaned,
            normalizedCommand: cleaned.toLowerCase(),
            targetDescription: parsedTarget.targetDescription,
            locatorHint: parsedTarget.locatorHint,
            inputValue
          };
        }

        if (pattern.kind === "element_validation") {
          const parsedTarget = parseTargetLocatorHint(match[1] || "");
          return {
            kind: "element_validation",
            rawCommand: cleaned,
            normalizedCommand: cleaned.toLowerCase(),
            targetDescription: parsedTarget.targetDescription,
            locatorHint: parsedTarget.locatorHint,
            assertionType: String(match[2] || "").toLowerCase() === "present" ? "present" : "visible",
            comparison: "equals"
          };
        }

        return {
          kind: "document_validation",
          rawCommand: cleaned,
          normalizedCommand: cleaned.toLowerCase(),
          assertionType: pattern.assertionType,
          comparison: pattern.comparison,
          explicitExpectedValue: stripWrappingQuotes(match[1] || "")
        };
      }
    }

    return null;
  }

  function getDocumentField(assertionType) {
    return assertionType === "document_title" ? "title" : "url";
  }

  function getDocumentActualValue(tab, assertionType) {
    return assertionType === "document_title" ? String(tab.title || "") : String(tab.url || "");
  }

  function buildDocumentTarget(tab, assertionType) {
    const documentField = getDocumentField(assertionType);
    const currentValue = getDocumentActualValue(tab, assertionType);

    return {
      targetType: "document",
      documentField,
      tagName: "document",
      id: "",
      dataTestId: "",
      name: "",
      selector: "",
      xpath: "",
      primaryLocator: {
        type: "document",
        value: documentField,
        stability: "strong"
      },
      locatorCandidates: [
        {
          type: "document",
          value: documentField,
          stability: "strong"
        }
      ],
      text: currentValue
    };
  }

  function buildNaturalLanguageEvent(commandShape, tab, commandLabel, source) {
    if (commandShape.kind === "navigation") {
      return {
        type: "navigation",
        action: "navigate",
        command: commandLabel || "navigate",
        url: tab.url || "",
        title: tab.title || "",
        target: {
          targetType: "document",
          documentField: "url",
          primaryLocator: {
            type: "document",
            value: "url",
            stability: "strong"
          },
          locatorCandidates: [
            {
              type: "document",
              value: "url",
              stability: "strong"
            }
          ]
        },
        details: {
          fromUrl: tab.url || "",
          toUrl: commandShape.destinationUrl,
          waitHints: buildWaitHints("navigate", commandShape),
          naturalLanguage: {
            rawCommand: commandShape.rawCommand,
            normalizedCommand: commandShape.normalizedCommand,
            source
          }
        }
      };
    }

    if (commandShape.kind === "click") {
      return {
        type: "click",
        action: "click",
        command: commandLabel || "click",
        url: tab.url || "",
        title: tab.title || "",
        target: buildDescriptionTarget(commandShape.targetDescription, commandShape.locatorHint),
        details: {
          waitHints: buildWaitHints("click", commandShape),
          naturalLanguage: {
            rawCommand: commandShape.rawCommand,
            normalizedCommand: commandShape.normalizedCommand,
            source
          }
        }
      };
    }

    if (commandShape.kind === "enter") {
      return {
        type: "change",
        action: "type",
        command: commandLabel || "enter",
        url: tab.url || "",
        title: tab.title || "",
        target: buildDescriptionTarget(commandShape.targetDescription, commandShape.locatorHint),
        details: {
          value: commandShape.inputValue,
          inputType: "text",
          naturalLanguage: {
            rawCommand: commandShape.rawCommand,
            normalizedCommand: commandShape.normalizedCommand,
            source
          }
        }
      };
    }

    if (commandShape.kind === "element_validation") {
      return {
        type: "validation",
        action: "validate",
        command: commandLabel || "add validation",
        url: tab.url || "",
        title: tab.title || "",
        target: buildDescriptionTarget(commandShape.targetDescription, commandShape.locatorHint),
        details: {
          validation: {
            mode: "single",
            assertionType: commandShape.assertionType,
            comparison: commandShape.comparison,
            expectedValue: "true",
            actualValue: null,
            source
          },
          naturalLanguage: {
            rawCommand: commandShape.rawCommand,
            normalizedCommand: commandShape.normalizedCommand,
            source
          }
        }
      };
    }

    const actualValue = getDocumentActualValue(tab, commandShape.assertionType);
    const expectedValue = commandShape.explicitExpectedValue || actualValue;

    return {
      type: "validation",
      action: "validate",
      command: commandLabel || "add validation",
      url: tab.url || "",
      title: tab.title || "",
      target: buildDocumentTarget(tab, commandShape.assertionType),
      details: {
        validation: {
          mode: "single",
          assertionType: commandShape.assertionType,
          comparison: commandShape.comparison,
          expectedValue,
          actualValue,
          source
        },
        naturalLanguage: {
          rawCommand: commandShape.rawCommand,
          normalizedCommand: commandShape.normalizedCommand,
          source
        }
      }
    };
  }

  globalScope.UIRecorderCommandUtils = {
    parseNaturalLanguageCommand,
    buildNaturalLanguageEvent
  };
})(window);

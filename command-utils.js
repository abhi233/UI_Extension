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
      }
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern.regex);
      if (match) {
        return {
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

# UI-Recorder

This extension records browser actions and manual validation commands, then exports a JSON file that can be converted into Selenium code by your internal Codex workflow.

## Standalone App

If your organization blocks Chrome extensions, use the standalone recorder instead of the extension.

Run:

```bash
node standalone/server.js
```

Then open:

```text
http://127.0.0.1:4791
```

Each new Chrome launch uses a fresh browser profile and opens only the URL you provide. Old managed profiles under `standalone/.chrome-profile` are cleaned up automatically.

The standalone app keeps the same JSON schema and supports:

- action recording through Chrome DevTools Protocol
- page-scoped sessions and export for the selected recorded page
- element picker validations
- table bulk validations
- text command validations
- voice command capture through the standalone UI
- named recordings
- recorded-step review with delete before export
- step search, action filters, and a session summary
- inline JSON step editing before export
- target list limited to 10 visible pages in the recorder UI

## What It Captures

- Click events
- Field changes (`input`, `textarea`, `select`)
- Password fields are recorded like normal input fields
- Form submit
- Page load marker
- Navigation event (`type: navigation`) when tab URL changes
- Validation command on any selected element
- Text or voice command events for navigate, click, enter, visible/present validation, document title, and current URL

Validation event now supports two modes:

- `single`: one element + one assertion
- `table_bulk`: one table locator + table scope metadata (your `.md` handles detailed table assertions)

Export metadata now includes:

- `schemaVersion`
- event-level `action`
- `target.primaryLocator`
- `target.locatorCandidates`
- `details.waitHints` for navigate and click flows
- `details.naturalLanguage` for command-driven validations

Locator recording rules:

- `selector` prefers `id`, `data-testid`, `name`, then relative CSS path
- `xpath` is always relative-style (`//*[@id='...']`, `//tag[@name='...']`, anchored descendant), never absolute root path like `/html/body/...`

## Install Locally

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   - `c:\Users\MSI\Downloads\Extension`

## How To Use

1. Click extension icon and press **Start Recording**
2. Perform actions in Chrome
3. To add validation:
   - Choose `Validation Mode`
   - Fill mode-specific fields
   - Click **Pick Element For Validation**
   - Click target element in page (or press `Esc` to cancel)
4. Press **Stop Recording**
5. Press **Export JSON**

## Voice And Text Commands

The popup can convert supported natural-language commands into validation events without picking a page element.

Supported now:

- `navigate to https://example.com`
- `click login button`
- `click "Sign In" button by text`
- `click login-submit by id`
- `enter john into username field`
- `enter secret123 into password by name`
- `validate login button is visible`
- `validate "Sign In" button by text is visible`
- `validate login button is present`
- `validate the title`
- `validate title contains login`
- `validate current url`
- `validate current url contains dashboard`

Voice input opens in a dedicated extension window so microphone permission and speech capture are more reliable than popup-based recognition. The transcript is reviewed before adding the event.

## Validation JSON Examples

`single` mode:

```json
{
  "schemaVersion": "1.0.0",
  "type": "validation",
  "target": {
    "selector": "#statusBadge",
    "xpath": "//*[@id='statusBadge']",
    "primaryLocator": {
      "type": "id",
      "value": "statusBadge",
      "stability": "strong"
    },
    "locatorCandidates": [
      { "type": "id", "value": "statusBadge", "stability": "strong" },
      { "type": "css", "value": "#statusBadge", "stability": "medium" },
      { "type": "xpath", "value": "//*[@id='statusBadge']", "stability": "medium" }
    ]
  },
  "details": {
    "validation": {
      "mode": "single",
      "command": "add validation",
      "assertionType": "text",
      "attributeName": "",
      "expectedValue": "Completed",
      "actualValue": "Completed"
    }
  }
}
```

`table_bulk` mode:

```json
{
  "type": "validation",
  "target": {
    "selector": "#ordersTable",
    "xpath": "//*[@id='ordersTable']"
  },
  "details": {
    "validation": {
      "mode": "table_bulk",
      "command": "add validation",
      "tableScope": {
        "rowStrategy": "all_rows",
        "columns": ["Order ID", "Status"],
        "keyColumn": "Order ID"
      },
      "tableFound": true,
      "rowCountPreview": 12
    }
  }
}
```

`natural-language document validation`:

```json
{
  "type": "validation",
  "action": "validate",
  "target": {
    "targetType": "document",
    "documentField": "title",
    "primaryLocator": {
      "type": "document",
      "value": "title",
      "stability": "strong"
    }
  },
  "details": {
    "validation": {
      "mode": "single",
      "assertionType": "document_title",
      "comparison": "contains",
      "expectedValue": "login",
      "actualValue": "Login - Demo App",
      "source": "voice"
    },
    "naturalLanguage": {
      "rawCommand": "validate title contains login",
      "normalizedCommand": "validate title contains login",
      "source": "voice"
    }
  }
}
```

`natural-language click with locator hint`:

```json
{
  "type": "click",
  "action": "click",
  "target": {
    "targetType": "description",
    "description": "Sign In button",
    "locatorHint": {
      "strategy": "text",
      "value": "Sign In",
      "match": "contains"
    },
    "primaryLocator": {
      "type": "text",
      "value": "Sign In",
      "match": "contains",
      "stability": "medium"
    }
  },
  "details": {
    "waitHints": {
      "before": [
        { "type": "element_actionable", "timeoutMs": 8000 }
      ],
      "after": [
        { "type": "dom_settled", "timeoutMs": 1000 },
        { "type": "optional_navigation", "timeoutMs": 10000 }
      ]
    }
  }
}
```

## Notes for Selenium Conversion

- Prefer `target.primaryLocator` first, then fallback through `target.locatorCandidates`.
- For natural-language description targets with `locatorHint`, prefer the hinted strategy before generic description matching.
- Branch by `details.validation.mode`:
  - `single` -> map by `assertionType` (`visible`, `text`, `value`, `attribute`)
  - `table_bulk` -> use table locator + `tableScope` and let your `.md` template generate row/column validations
- For natural-language document validations, branch on `target.targetType === "document"` and map:
  - `document_title`
  - `document_url`
- For `details.waitHints`, map:
  - `url_matches` / `document_ready_state` after navigation
  - `element_actionable` before click
  - `dom_settled` and `optional_navigation` after click

If you share your framework `.md` file in this folder, this recorder output can be aligned exactly to your command format in the next step.

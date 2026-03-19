# Per-Sentence Translation Tool — Technical Documentation

A Google Translate-inspired text translation tool that uses Azure OpenAI to translate text **sentence-by-sentence**, enabling per-sentence highlighting, retranslation, and user-guided feedback. This document covers the full architecture, data flow, API contracts, and implementation details needed to understand and reproduce the system.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Core Concept: Sentence-Level Translation](#4-core-concept-sentence-level-translation)
5. [Server API Reference](#5-server-api-reference)
6. [LLM Tool Calling Strategy](#6-llm-tool-calling-strategy)
7. [SSE Streaming Protocol](#7-sse-streaming-protocol)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Data Flow: Full Translation](#9-data-flow-full-translation)
10. [Data Flow: Retranslation](#10-data-flow-retranslation)
11. [Incremental JSON Array Streaming](#11-incremental-json-array-streaming)
12. [UI Panel Architecture](#12-ui-panel-architecture)
13. [Setup & Running](#13-setup--running)

---

## 1. Architecture Overview

```
┌──────────────────────┐         SSE (POST)         ┌──────────────────────┐
│                      │  ──────────────────────►   │                      │
│   React Frontend     │                            │   Express Server     │
│   (Vite + TS)        │  ◄──────────────────────   │   (Node.js + TS)     │
│                      │    event-stream chunks     │                      │
│   Port 5173          │                            │   Port 3001          │
└──────────────────────┘         JSON (POST)        └──────────┬───────────┘
                          ──────────────────────►              │
                          ◄──────────────────────              │ Multi-turn
                            /api/retranslate                   │ tool calling
                                                                │ (streaming)
                                                    ┌───────────▼───────────┐
                                                    │                       │
                                                    │   Azure OpenAI API    │
                                                    │   (GPT model)         │
                                                    │                       │
                                                    └───────────────────────┘
```

The system has two main flows:
- **Full translation**: Frontend POSTs source text → Server streams SSE events back via multi-turn LLM tool calling
- **Retranslation**: Frontend POSTs context + sentence ID → Server makes a single LLM call → returns JSON

---

## 2. Tech Stack

### Server
| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Framework | Express 4 |
| LLM Client | `openai` npm package (AzureOpenAI class) |
| Dev runner | `tsx watch` (hot reload) |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | React 19 + TypeScript |
| Build tool | Vite 8 |
| Styling | Plain CSS (no framework) |
| State management | React hooks + DOM refs |

---

## 3. Project Structure

```
test-instant-text-translation/
├── server/
│   ├── src/
│   │   └── index.ts          # All server logic (APIs, LLM interaction, SSE)
│   ├── .env                   # Azure OpenAI credentials (not committed)
│   ├── .env.example           # Template for .env
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── App.tsx            # Main React component (all UI logic)
    │   ├── App.css            # All styling
    │   ├── index.css           # Base styles (Vite scaffold)
    │   └── main.tsx           # React entry point
    ├── package.json
    └── tsconfig.json
```

---

## 4. Core Concept: Sentence-Level Translation

Unlike simple text translation that treats the entire input as a blob, this system **splits text into individual sentences** and translates each one independently while maintaining structural context. This enables:

1. **Per-sentence display**: Each sentence is a separate DOM element (`<p id="N">`)
2. **Cross-panel highlighting**: Hover over a translated sentence to highlight it AND its source counterpart
3. **Selective retranslation**: Click any translated sentence to retranslate just that one, optionally with user feedback
4. **Preserved formatting**: Line breaks in the original text are preserved as `<br>` in an HTML template

### The Template System

The LLM generates an **HTML template** that separates structure from content:

**Input text:**
```
Hello world. How are you?

I am fine. Thank you.
```

**Generated template:**
```html
<p id="0"></p> <p id="1"></p><br><p id="2"></p> <p id="3"></p>
```

**Source sentences array:**
```json
["Hello world.", "How are you?", "I am fine.", "Thank you."]
```

**Translated sentences array:**
```json
["你好世界。", "你好吗？", "我很好。", "谢谢你。"]
```

Key design decisions:
- `<p>` tags are `display: inline` so sentences flow naturally within paragraphs
- `<br>` tags represent line breaks from the original text
- Multiple `<p>` tags can appear on the same line (same paragraph)
- The `id` attribute on each `<p>` is the index into both the source and translated arrays

---

## 5. Server API Reference

### `GET /api/languages`

Returns the supported language map.

**Response:**
```json
{
  "en": "English",
  "zh": "Chinese (Simplified)",
  "ms": "Bahasa Melayu",
  "hi": "Hindi"
}
```

### `POST /api/translate`

Full translation with SSE streaming. Returns `text/event-stream`.

**Request body:**
```json
{
  "text": "Hello world. How are you?",
  "targetLang": "zh"
}
```

**Response:** Server-Sent Events stream (see [Section 7](#7-sse-streaming-protocol)).

### `POST /api/retranslate`

Retranslate a single sentence with full context.

**Request body:**
```json
{
  "sourceText": "Hello world. How are you?\n\nI am fine.",
  "sourceSentences": ["Hello world.", "How are you?", "I am fine."],
  "translatedSentences": ["你好世界。", "你好吗？", "我很好。"],
  "sentenceId": 1,
  "targetLang": "zh",
  "feedback": "Make it more casual"    // optional
}
```

**Response:**
```json
{
  "id": 1,
  "translated_text": "你怎么样？"
}
```

---

## 6. LLM Tool Calling Strategy

The full translation uses **OpenAI function calling (tools)** with a **multi-turn conversation loop**. This is the most critical part of the architecture.

### Why Multi-Turn?

OpenAI models execute tool calls and then **stop**, returning `finish_reason: "tool_calls"`. They expect tool results before continuing. A single request **cannot** call all 3 tools. The server must:

1. Send messages → LLM calls tool → stops
2. Append assistant message (with tool call) + tool result message
3. Call LLM again → LLM calls next tool → stops
4. Repeat until done

### The Three Tools

#### Tool 1: `detectedLang`
```json
{
  "name": "detectedLang",
  "parameters": {
    "language": "English"   // enum: English, Simplified Chinese, Bahasa Melayu, Hindi
  }
}
```
**Purpose:** Detect and report the source language.
**Server action:** Sends `update_source_lang` SSE event. Returns `"Language detected successfully."` as tool result.

#### Tool 2: `save_template`
```json
{
  "name": "save_template",
  "parameters": {
    "html_template": "<p id=\"0\"></p> <p id=\"1\"></p><br><p id=\"2\"></p>",
    "source_sentences": ["Hello world.", "How are you?", "I am fine."]
  }
}
```
**Purpose:** Split text into sentences and create the HTML template.
**Server action:** Sends `update_source_text` SSE event with template + sentences. Returns `"Template saved successfully."` as tool result.

#### Tool 3: `translateResult`
```json
{
  "name": "translateResult",
  "parameters": {
    "translated_sentences": ["你好世界。", "你好吗？", "我很好。"]
  }
}
```
**Purpose:** Translate each sentence, maintaining 1:1 index mapping.
**Server action:** Streams `update_translated_text` SSE events incrementally as each array element completes during streaming. Returns `"Translation complete."` as tool result. Sets `done = true` to end the loop.

### Multi-Turn Conversation Flow

```
Messages:  [system, user]
                │
                ▼
        LLM call #1 (stream: true)
        LLM returns: tool_call detectedLang({"language":"English"})
        finish_reason: "tool_calls"
                │
                ├── Send SSE: update_source_lang
                ├── Append: assistant message with tool_call
                ├── Append: tool result "Language detected successfully."
                │
                ▼
Messages:  [system, user, assistant(tool_call), tool(result)]
                │
                ▼
        LLM call #2 (stream: true)
        LLM returns: tool_call save_template({...})
        finish_reason: "tool_calls"
                │
                ├── Send SSE: update_source_text
                ├── Append: assistant message with tool_call
                ├── Append: tool result "Template saved successfully."
                │
                ▼
Messages:  [system, user, asst, tool, asst(tool_call), tool(result)]
                │
                ▼
        LLM call #3 (stream: true)
        LLM returns: tool_call translateResult({...})
        finish_reason: "tool_calls"
                │
                ├── Stream SSE: update_translated_text (per sentence, incrementally)
                ├── done = true (exit loop)
                │
                ▼
        Send SSE: done
        Close connection
```

### System Prompt

```
You are a translation engine. Translate the user's text to {targetName}.

You MUST call all three tools in this order:
1. "detectedLang" — detect and report the source language.
2. "save_template" — split the user's text into sentences. Create an HTML template
   with <p id="0"></p>, <p id="1"></p>, ... for each sentence. Use <br> for line
   breaks (where the original text has blank lines or newlines). Multiple sentences
   in the same paragraph should have their <p> tags adjacent with a space between
   them. The source_sentences array must contain the exact original text of each
   sentence, matching by index.
3. "translateResult" — translate each sentence and return as an array matching the
   same indices.

Do not output any text outside of tool calls.
```

---

## 7. SSE Streaming Protocol

The server uses Server-Sent Events over a POST request. All events use the `message` event type with a JSON data payload containing an `action` field.

### Event Format
```
event: message
data: {"action":"<action_name>", ...fields}

```

### SSE Actions

| Action | Payload | When Sent |
|--------|---------|-----------|
| `update_source_lang` | `{ action, value: "English" }` | After `detectedLang` tool completes |
| `update_source_text` | `{ action, template: "<html>", sentences: ["..."] }` | After `save_template` tool completes |
| `update_translated_text` | `{ action, index: 0, value: "translated sentence" }` | Incrementally as each array element completes during `translateResult` streaming |
| `error` | `{ action, value: "error message" }` | On any error |
| `done` | `{ action: "done" }` | Translation complete |

### Frontend SSE Consumption

The frontend uses `fetch()` + `ReadableStream` (not `EventSource`, since it's a POST):

```typescript
const reader = res.body.getReader();
const decoder = new TextDecoder();
let partial = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  partial += decoder.decode(value, { stream: true });
  const lines = partial.split("\n");
  partial = lines.pop() || "";

  let eventType = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7);
    } else if (line.startsWith("data: ") && eventType) {
      const data = JSON.parse(line.slice(6));
      // handle data.action
      eventType = "";
    }
  }
}
```

Key detail: `partial` accumulates incomplete lines across chunks to handle SSE messages split across network packets.

---

## 8. Frontend Architecture

### State Management Strategy

The frontend uses a hybrid approach:
- **React state** for values that affect rendering: `sourceText`, `detectedLang`, `targetLang`, `languages`, `showTemplate`, `selectedId`
- **DOM refs** for imperatively-managed content: `sourceRef`, `outputRef` (these hold the HTML template content set via `innerHTML`)
- **Plain refs** for non-rendering values: `loadingRef`, `templateRef`, `debounceRef`, `abortRef`

**Why refs for output content?** React re-renders wipe `innerHTML` set via refs. By keeping the output div empty in JSX and managing its content purely through refs, React never touches its inner DOM.

### Debounced Translation

User input triggers translation with a 500ms debounce:

```
User types → setSourceText → useEffect fires → clearTimeout → setTimeout(500ms)
                                                                      │
User types again (within 500ms) → clears previous timeout ──────────┘
                                                                      │
500ms passes with no typing → translate() called ◄───────────────────┘
```

### AbortController for Request Cancellation

Each translation creates a new `AbortController`. If the user types again before the previous translation completes, the old request is aborted:

```typescript
if (abortRef.current) abortRef.current.abort();  // cancel previous
const controller = new AbortController();
abortRef.current = controller;
// ... fetch with signal: controller.signal
```

---

## 9. Data Flow: Full Translation

```
User types "Hello. World."
        │
        ▼ (500ms debounce)
Frontend: POST /api/translate { text: "Hello. World.", targetLang: "zh" }
        │
        ▼
Server: Sets SSE headers, starts multi-turn LLM loop
        │
        ▼ (LLM turn 1)
Server SSE → { action: "update_source_lang", value: "English" }
Frontend: Updates "Detected: English" label
        │
        ▼ (LLM turn 2)
Server SSE → { action: "update_source_text",
               template: '<p id="0"></p> <p id="1"></p>',
               sentences: ["Hello.", "World."] }
Frontend:
  1. sourceRef.innerHTML = template
  2. Fill source <p> tags with sentences
  3. outputRef.innerHTML = template (empty placeholders)
  4. setShowTemplate(true) → swap textarea for display div
        │
        ▼ (LLM turn 3, streamed)
Server SSE → { action: "update_translated_text", index: 0, value: "你好。" }
Frontend: outputRef.querySelector('p[id="0"]').textContent = "你好。"

Server SSE → { action: "update_translated_text", index: 1, value: "世界。" }
Frontend: outputRef.querySelector('p[id="1"]').textContent = "世界。"

Server SSE → { action: "done" }
```

---

## 10. Data Flow: Retranslation

```
User hovers over translated sentence → highlight on both panels
        │
User clicks translated sentence
        │
        ▼
Frontend: setSelectedId(N) → toolbar appears below the <p>
        │
User clicks "Retry" or "Retry with feedback"
        │ (if feedback: window.prompt() shown first)
        ▼
Frontend: setSelectedId(null) → toolbar disappears
Frontend: POST /api/retranslate {
  sourceText: "full original text",
  sourceSentences: ["Hello.", "World."],
  translatedSentences: ["你好。", "世界。"],   // read from DOM
  sentenceId: 1,
  targetLang: "zh",
  feedback: "Make it more casual"              // optional
}
        │
        ▼
Server: Single LLM call (non-streaming) with full context prompt:
  - System: "Retranslate ONLY the highlighted sentence to {lang}"
  - System (if feedback): "User feedback: {feedback}"
  - User: Full source + existing translations + highlighted sentence
        │
        ▼
Server → { id: 1, translated_text: "世界啊。" }
        │
        ▼
Frontend: outputRef.querySelector('p[id="1"]').textContent = "世界啊。"
```

### Retranslation LLM Prompt Structure

```
System: You are a translation engine. Retranslate ONLY the highlighted
sentence to {targetName}, improving accuracy and fluency using context.
[If feedback: "The user has provided the following feedback: {feedback}"]
Reply with ONLY the retranslated sentence.

User:
Full source text:
{sourceText}

Existing translation (sentence by sentence):
[0] Hello. → 你好。
[1] World. → 世界。

Please retranslate sentence [1]:
Source: World.
Current translation: 世界。

Provide an improved translation for this sentence:
```

---

## 11. Incremental JSON Array Streaming

When the `translateResult` tool streams its arguments, the JSON is delivered in fragments:

```
{"translated_sentences":["你好    ← chunk 1
。","世界                          ← chunk 2
。"]}                              ← chunk 3
```

The server uses `extractCompletedArrayElements()` to parse completed string elements from partial JSON without waiting for the full response:

**Algorithm:**
1. Find the field name (`"translated_sentences"`) and the opening `[`
2. Walk character-by-character, tracking string boundaries and escape sequences
3. When a closing `"` is followed by `,` or `]`, the string element is complete
4. Unescape the JSON string (handle `\n`, `\"`, `\\`, etc.)
5. Track how many elements have been sent (`sentTranslatedCount`) to avoid duplicates

This allows sentence-by-sentence progressive rendering: each translated sentence appears in the UI as soon as the LLM finishes generating it, rather than waiting for the entire array.

---

## 12. UI Panel Architecture

### Source Panel (Left)

Uses a **swap pattern** between two elements:

```
┌─────────────────────────┐
│ .source-wrapper          │
│                          │
│  ┌─ textarea ──────────┐ │  ← Visible while typing (showTemplate=false)
│  │ User types here     │ │
│  └─────────────────────┘ │
│                          │
│  ┌─ .source-display ───┐ │  ← Visible after template arrives (showTemplate=true)
│  │ <p id=0>Hello.</p>  │ │    Contains template with <p> tags
│  │ <p id=1>World.</p>  │ │    Enables per-sentence highlighting
│  └─────────────────────┘ │    Click → swaps back to textarea
│                          │
└─────────────────────────┘
```

### Output Panel (Right)

```
┌─────────────────────────┐
│ .output-wrapper          │
│                          │
│  ┌─ .text-area.output ─┐ │  ← Managed via refs (innerHTML)
│  │ <p id=0>你好。</p>   │ │    Contains template + translated text
│  │ <p id=1>世界。</p>   │ │    Hover → highlight both panels
│  └─────────────────────┘ │    Click → show toolbar
│                          │
│  ┌─ .retranslate-toolbar┐│  ← Absolutely positioned below clicked <p>
│  │ [Retry] [Feedback]   ││    Shown when selectedId !== null
│  └──────────────────────┘│
│                          │
└─────────────────────────┘
```

### Cross-Panel Highlighting

When the user hovers over a `<p>` in the output panel:

1. `onMouseOver` event delegation finds the closest `p[id]`
2. Adds `.highlight` class to that `<p>` (light yellow background)
3. Finds the `<p>` with matching `id` in `sourceRef` and adds `.highlight` there too
4. `onMouseOut` removes both `.highlight` classes

### Toolbar Positioning

The toolbar is absolutely positioned within `.output-wrapper`:

```typescript
const pRect = el.getBoundingClientRect();
const outputRect = outputRef.current.getBoundingClientRect();

toolbar.style.top = pRect.bottom - outputRect.top + outputRef.current.scrollTop;
toolbar.style.left = pRect.left - outputRect.left;
```

This accounts for scrolling within the output panel.

---

## 13. Setup & Running

### Prerequisites

- Node.js 18+
- Azure OpenAI resource with a deployed chat model

### Server Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your Azure OpenAI credentials:
#   AZURE_OPENAI_API_KEY=your-key
#   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
#   AZURE_OPENAI_DEPLOYMENT=your-deployment-name
#   AZURE_OPENAI_API_VERSION=2024-08-01-preview
npm run dev
```

Server runs on `http://localhost:3001`.

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | Yes | Model deployment name |
| `AZURE_OPENAI_API_VERSION` | No | API version (default: `2024-08-01-preview`) |

### Supported Languages

| Code | Language |
|------|----------|
| `en` | English |
| `zh` | Chinese (Simplified) |
| `ms` | Bahasa Melayu |
| `hi` | Hindi |

To add a new language, add it to the `SUPPORTED_LANGUAGES` map in `server/src/index.ts` and update the `detectedLang` tool's enum.

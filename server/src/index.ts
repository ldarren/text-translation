import "dotenv/config";
import express from "express";
import cors from "cors";
import { AzureOpenAI } from "openai";
import type {
  ChatCompletionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const client = new AzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
});

const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: "English",
  zh: "Chinese (Simplified)",
  ms: "Bahasa Melayu",
  hi: "Hindi",
};

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "detectedLang",
      description: "Report the detected source language of the user's text.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["English", "Simplified Chinese", "Bahasa Melayu", "Hindi"],
            description: "The detected source language name.",
          },
        },
        required: ["language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_template",
      description:
        'Save the HTML template and extracted source text sentences. The template uses <p id="0"></p>, <p id="1"></p>, etc. for each sentence, and <br> for line breaks between paragraphs. Multiple <p> tags can appear on the same line (same paragraph). Example: for input \'Hello world. How are you?\\n\\nI am fine.\', the template is \'<p id="0"></p> <p id="1"></p><br><p id="2"></p>\' and source_sentences is ["Hello world.", "How are you?", "I am fine."].',
      parameters: {
        type: "object",
        properties: {
          html_template: {
            type: "string",
            description:
              'HTML template with <p id="N"></p> placeholders for each sentence and <br> for line breaks.',
          },
          source_sentences: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of source text sentences, matching the <p> tag IDs in the template.",
          },
        },
        required: ["html_template", "source_sentences"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "translateResult",
      description:
        "Output the translated sentences as an array. Each element corresponds to the same index in the source_sentences array from save_template.",
      parameters: {
        type: "object",
        properties: {
          translated_sentences: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of translated sentences, matching 1:1 with source_sentences by index.",
          },
        },
        required: ["translated_sentences"],
      },
    },
  },
];

app.get("/api/languages", (_req, res) => {
  res.json(SUPPORTED_LANGUAGES);
});

function sendSSE(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/translate", async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text || !targetLang) {
    res.status(400).json({ error: "text and targetLang are required" });
    return;
  }

  if (!SUPPORTED_LANGUAGES[targetLang]) {
    res.status(400).json({ error: "Unsupported target language" });
    return;
  }

  const targetName = SUPPORTED_LANGUAGES[targetLang];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a translation engine. Translate the user's text to ${targetName}.

You MUST call all three tools in this order:
1. "detectedLang" — detect and report the source language.
2. "save_template" — split the user's text into sentences. Create an HTML template with <p id="0"></p>, <p id="1"></p>, ... for each sentence. Use <br> for line breaks (where the original text has blank lines or newlines). Multiple sentences in the same paragraph should have their <p> tags adjacent with a space between them. The source_sentences array must contain the exact original text of each sentence, matching by index.
3. "translateResult" — translate each sentence and return as an array matching the same indices.

Do not output any text outside of tool calls.`,
    },
    {
      role: "user",
      content: text,
    },
  ];

  console.log("\n=== Translation Request ===");
  console.log("Input text:", JSON.stringify(text));
  console.log("Target language:", targetName);

  try {
    let sentTranslatedCount = 0;
    let done = false;

    // Multi-turn loop: keep calling LLM until it stops requesting tools
    while (!done) {
      console.log(`\n--- LLM call (${messages.length} messages) ---`);

      const stream = await client.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT!,
        messages,
        tools,
        temperature: 1,
        stream: true,
      });

      // Collect tool calls from this turn
      const toolCalls: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};
      let finishReason = "";

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta?.tool_calls) continue;

        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: "", name: "", arguments: "" };
          }

          if (tc.id) {
            toolCalls[idx].id = tc.id;
          }

          if (tc.function?.name) {
            toolCalls[idx].name = tc.function.name;
            console.log(`  Tool call started: ${tc.function.name}`);
          }

          if (tc.function?.arguments) {
            toolCalls[idx].arguments += tc.function.arguments;

            // Stream translated sentences incrementally
            if (toolCalls[idx].name === "translateResult") {
              try {
                const sentences = extractCompletedArrayElements(
                  toolCalls[idx].arguments,
                  "translated_sentences"
                );
                while (sentTranslatedCount < sentences.length) {
                  console.log(
                    `  Streaming translated [${sentTranslatedCount}]:`,
                    sentences[sentTranslatedCount]
                  );
                  sendSSE(res, "message", {
                    action: "update_translated_text",
                    index: sentTranslatedCount,
                    value: sentences[sentTranslatedCount],
                  });
                  sentTranslatedCount++;
                }
              } catch {
                // partial JSON
              }
            }
          }
        }
      }

      console.log(`  Finish reason: ${finishReason}`);
      console.log(
        `  Tool calls:`,
        Object.values(toolCalls).map((tc) => tc.name)
      );

      if (finishReason !== "tool_calls" || Object.keys(toolCalls).length === 0) {
        done = true;
        break;
      }

      // Process each tool call: send SSE + append assistant & tool messages
      // First, append the assistant message with all tool calls from this turn
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: Object.values(toolCalls).map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (const tc of Object.values(toolCalls)) {
        console.log(`\n  Processing tool: ${tc.name}`);
        console.log(`  Arguments: ${tc.arguments}`);

        let toolResult = "ok";

        if (tc.name === "detectedLang") {
          try {
            const parsed = JSON.parse(tc.arguments);
            console.log(`  -> Detected: ${parsed.language}`);
            sendSSE(res, "message", {
              action: "update_source_lang",
              value: parsed.language,
            });
            toolResult = "Language detected successfully.";
          } catch (e) {
            console.error("  Failed to parse detectedLang:", e);
            toolResult = "Error parsing arguments.";
          }
        } else if (tc.name === "save_template") {
          try {
            const parsed = JSON.parse(tc.arguments);
            console.log(`  -> Template: ${parsed.html_template}`);
            console.log(`  -> Sentences: ${JSON.stringify(parsed.source_sentences)}`);
            sendSSE(res, "message", {
              action: "update_source_text",
              template: parsed.html_template,
              sentences: parsed.source_sentences,
            });
            toolResult = "Template saved successfully.";
          } catch (e) {
            console.error("  Failed to parse save_template:", e);
            toolResult = "Error parsing arguments.";
          }
        } else if (tc.name === "translateResult") {
          try {
            const parsed = JSON.parse(tc.arguments);
            const sentences: string[] = parsed.translated_sentences;
            // Send any remaining sentences not yet streamed
            while (sentTranslatedCount < sentences.length) {
              sendSSE(res, "message", {
                action: "update_translated_text",
                index: sentTranslatedCount,
                value: sentences[sentTranslatedCount],
              });
              sentTranslatedCount++;
            }
            toolResult = "Translation complete.";
          } catch (e) {
            console.error("  Failed to parse translateResult:", e);
            toolResult = "Error parsing arguments.";
          }
          // translateResult is the last tool, we're done
          done = true;
        }

        // Append tool result so LLM can continue
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    }

    console.log("\n=== Translation complete ===");
    sendSSE(res, "message", { action: "done" });
  } catch (err) {
    console.error("Translation error:", err);
    sendSSE(res, "message", {
      action: "error",
      value: "Translation failed",
    });
  }

  res.end();
});

/**
 * Extract completed string elements from a partially-streamed JSON object
 * containing an array field.
 */
function extractCompletedArrayElements(
  partial: string,
  fieldName: string
): string[] {
  const results: string[] = [];
  const fieldPattern = `"${fieldName}"`;
  const fieldIdx = partial.indexOf(fieldPattern);
  if (fieldIdx === -1) return results;

  const afterField = partial.slice(fieldIdx + fieldPattern.length);
  const bracketIdx = afterField.indexOf("[");
  if (bracketIdx === -1) return results;

  let inString = false;
  let escaped = false;
  let current = "";
  let depth = 0;

  for (let i = bracketIdx + 1; i < afterField.length; i++) {
    const ch = afterField[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        current = "";
      } else {
        inString = false;
        let j = i + 1;
        while (j < afterField.length && /\s/.test(afterField[j])) j++;
        if (
          j < afterField.length &&
          (afterField[j] === "," || afterField[j] === "]")
        ) {
          try {
            results.push(JSON.parse(`"${current}"`));
          } catch {
            results.push(current);
          }
        }
      }
      continue;
    }

    if (inString) {
      current += ch;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      if (depth === 0) break;
      depth--;
    }
  }

  return results;
}

app.post("/api/retranslate", async (req, res) => {
  const { sourceText, translatedSentences, sourceSentences, sentenceId, targetLang, feedback } =
    req.body;

  if (
    !sourceText ||
    !translatedSentences ||
    !sourceSentences ||
    sentenceId === undefined ||
    !targetLang
  ) {
    res
      .status(400)
      .json({ error: "sourceText, translatedSentences, sourceSentences, sentenceId, and targetLang are required" });
    return;
  }

  if (!SUPPORTED_LANGUAGES[targetLang]) {
    res.status(400).json({ error: "Unsupported target language" });
    return;
  }

  const targetName = SUPPORTED_LANGUAGES[targetLang];
  const highlightedSource = sourceSentences[sentenceId];
  const currentTranslation = translatedSentences[sentenceId];

  console.log("\n=== Retranslate Request ===");
  console.log("Sentence ID:", sentenceId);
  console.log("Source sentence:", highlightedSource);
  console.log("Current translation:", currentTranslation);
  console.log("Target language:", targetName);
  if (feedback) console.log("User feedback:", feedback);

  try {
    const completion = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT!,
      messages: [
        {
          role: "system",
          content: `You are a translation engine. You will be given a full source text and its existing translation as context. Your task is to retranslate ONLY the highlighted sentence to ${targetName}, improving accuracy and fluency using the surrounding context.${
            feedback
              ? `\n\nThe user has provided the following feedback to guide your retranslation:\n"${feedback}"`
              : ""
          }

Reply with ONLY the retranslated sentence, no explanation, no quotes, no extra text.`,
        },
        {
          role: "user",
          content: `Full source text:
${sourceText}

Existing translation (sentence by sentence):
${sourceSentences
  .map(
    (s: string, i: number) =>
      `[${i}] ${s} → ${translatedSentences[i] || "(not yet translated)"}`
  )
  .join("\n")}

Please retranslate sentence [${sentenceId}]:
Source: ${highlightedSource}
Current translation: ${currentTranslation}

Provide an improved translation for this sentence:`,
        },
      ],
      temperature: 1,
    });

    const newTranslation = completion.choices[0]?.message?.content?.trim();
    console.log("New translation:", newTranslation);

    if (!newTranslation) {
      res.status(500).json({ error: "Empty response from Azure OpenAI" });
      return;
    }

    res.json({
      id: sentenceId,
      translated_text: newTranslation,
    });
  } catch (err) {
    console.error("Retranslate error:", err);
    res.status(500).json({ error: "Retranslation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

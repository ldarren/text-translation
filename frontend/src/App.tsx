import { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

const API_URL = "http://localhost:3001/api";

interface Languages {
  [code: string]: string;
}

function App() {
  const [sourceText, setSourceText] = useState("");
  const [detectedLang, setDetectedLang] = useState("");
  const [targetLang, setTargetLang] = useState("zh");
  const [languages, setLanguages] = useState<Languages>({});
  const [showTemplate, setShowTemplate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const loadingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const abortRef = useRef<AbortController>(null);
  const templateRef = useRef<{ template: string; sentences: string[] } | null>(
    null
  );
  const sourceRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_URL}/languages`)
      .then((res) => res.json())
      .then(setLanguages)
      .catch(console.error);
  }, []);

  const clearPanels = useCallback(() => {
    templateRef.current = null;
    setShowTemplate(false);
    setSelectedId(null);
    if (sourceRef.current) sourceRef.current.innerHTML = "";
    if (outputRef.current) outputRef.current.innerHTML = "";
  }, []);

  const translate = useCallback(
    async (text: string, target: string) => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      loadingRef.current = true;
      setDetectedLang("");
      clearPanels();
      if (outputRef.current) {
        outputRef.current.textContent = "Translating...";
      }

      try {
        const res = await fetch(`${API_URL}/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, targetLang: target }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          if (outputRef.current) {
            outputRef.current.textContent = `Error: ${data.error || "Request failed"}`;
          }
          loadingRef.current = false;
          return;
        }

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
              if (eventType === "message") {
                handleSSEMessage(data);
              }
              eventType = "";
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (outputRef.current) {
          outputRef.current.textContent = "Error: Could not connect to server";
        }
      } finally {
        loadingRef.current = false;
      }
    },
    [clearPanels]
  );

  const handleSSEMessage = useCallback(
    (data: { action: string; [key: string]: unknown }) => {
      switch (data.action) {
        case "update_source_lang":
          setDetectedLang(data.value as string);
          break;

        case "update_source_text": {
          const template = data.template as string;
          const sentences = data.sentences as string[];

          templateRef.current = { template, sentences };

          if (sourceRef.current) {
            sourceRef.current.innerHTML = template;
            sentences.forEach((sentence, i) => {
              const el = sourceRef.current!.querySelector(`p[id="${i}"]`);
              if (el) el.textContent = sentence;
            });
          }

          if (outputRef.current) {
            outputRef.current.innerHTML = template;
          }

          setShowTemplate(true);
          break;
        }

        case "update_translated_text": {
          const index = data.index as number;
          const value = data.value as string;
          if (outputRef.current) {
            const el = outputRef.current.querySelector(`p[id="${index}"]`);
            if (el) el.textContent = value;
          }
          break;
        }

        case "error":
          if (outputRef.current) {
            outputRef.current.textContent = `Error: ${data.value}`;
          }
          break;

        case "done":
          break;
      }
    },
    []
  );

  const getTranslatedSentences = useCallback((): string[] => {
    if (!outputRef.current || !templateRef.current) return [];
    return templateRef.current.sentences.map((_, i) => {
      const el = outputRef.current!.querySelector(`p[id="${i}"]`);
      return el?.textContent || "";
    });
  }, []);

  const retranslate = useCallback(
    async (sentenceId: number, feedback?: string) => {
      if (!templateRef.current || !outputRef.current) return;

      const translatedSentences = getTranslatedSentences();
      const targetEl = outputRef.current.querySelector(
        `p[id="${sentenceId}"]`
      );
      if (targetEl) targetEl.classList.add("retranslating");

      try {
        const body: Record<string, unknown> = {
          sourceText,
          sourceSentences: templateRef.current.sentences,
          translatedSentences,
          sentenceId,
          targetLang,
        };
        if (feedback) body.feedback = feedback;

        const res = await fetch(`${API_URL}/retranslate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        if (data.error) {
          console.error("Retranslate error:", data.error);
          return;
        }

        if (outputRef.current) {
          const el = outputRef.current.querySelector(`p[id="${data.id}"]`);
          if (el) el.textContent = data.translated_text;
        }
      } catch (err) {
        console.error("Retranslate failed:", err);
      } finally {
        if (targetEl) targetEl.classList.remove("retranslating");
      }
    },
    [sourceText, targetLang, getTranslatedSentences]
  );

  // Click on output <p> to show/hide toolbar
  const handleOutputClick = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest("p[id]");
      if (!target || !templateRef.current) return;
      const id = parseInt(target.getAttribute("id")!, 10);

      if (selectedId === id) {
        setSelectedId(null);
      } else {
        setSelectedId(id);
      }
    },
    [selectedId]
  );

  const handleRetry = useCallback(() => {
    if (selectedId === null) return;
    const id = selectedId;
    setSelectedId(null);
    retranslate(id);
  }, [selectedId, retranslate]);

  const handleRetryWithFeedback = useCallback(() => {
    if (selectedId === null) return;
    const id = selectedId;
    setSelectedId(null);
    const feedback = window.prompt("Enter feedback to improve the translation:");
    if (feedback === null) return;
    if (!feedback.trim()) return;
    retranslate(id, feedback.trim());
  }, [selectedId, retranslate]);

  // Position toolbar below the selected <p>
  useEffect(() => {
    if (selectedId === null || !toolbarRef.current || !outputRef.current) return;

    const el = outputRef.current.querySelector(`p[id="${selectedId}"]`);
    if (!el) return;

    const pRect = el.getBoundingClientRect();
    const outputRect = outputRef.current.getBoundingClientRect();

    toolbarRef.current.style.top = `${pRect.bottom - outputRect.top + outputRef.current.scrollTop}px`;
    toolbarRef.current.style.left = `${pRect.left - outputRect.left}px`;
  }, [selectedId]);

  // Close toolbar when clicking outside
  useEffect(() => {
    if (selectedId === null) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        toolbarRef.current?.contains(target) ||
        target.closest(".text-area.output p[id]")
      ) {
        return;
      }
      setSelectedId(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [selectedId]);

  // Hover highlight
  const handleOutputMouseOver = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("p[id]");
    if (!target) return;
    const id = target.getAttribute("id");
    if (!id) return;

    target.classList.add("highlight");
    const sourceEl = sourceRef.current?.querySelector(`p[id="${id}"]`);
    if (sourceEl) sourceEl.classList.add("highlight");
  }, []);

  const handleOutputMouseOut = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("p[id]");
    if (!target) return;
    const id = target.getAttribute("id");
    if (!id) return;

    target.classList.remove("highlight");
    const sourceEl = sourceRef.current?.querySelector(`p[id="${id}"]`);
    if (sourceEl) sourceEl.classList.remove("highlight");
  }, []);

  const handleSourceDisplayClick = useCallback(() => {
    setShowTemplate(false);
    setSelectedId(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!sourceText.trim()) {
      if (abortRef.current) abortRef.current.abort();
      clearPanels();
      setDetectedLang("");
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => translate(sourceText, targetLang),
      500
    );
  }, [sourceText, targetLang, translate, clearPanels]);

  return (
    <div className="app">
      <h1>Text Translator</h1>
      <div className="translator">
        <div className="panel">
          <div className="panel-header">
            <span className="lang-label">
              {detectedLang
                ? `Detected: ${detectedLang}`
                : "Auto-detect language"}
            </span>
          </div>
          <div className="source-wrapper">
            <textarea
              ref={textareaRef}
              className={`text-input ${showTemplate ? "hidden" : ""}`}
              placeholder="Enter text to translate..."
              value={sourceText}
              onChange={(e) => {
                setSourceText(e.target.value);
                setShowTemplate(false);
                setSelectedId(null);
              }}
            />
            <div
              ref={sourceRef}
              className={`source-display ${showTemplate ? "visible" : ""}`}
              onClick={handleSourceDisplayClick}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <select
              className="lang-select"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
            >
              {Object.entries(languages).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="output-wrapper">
            <div
              ref={outputRef}
              className="text-area output"
              onMouseOver={handleOutputMouseOver}
              onMouseOut={handleOutputMouseOut}
              onClick={handleOutputClick}
            />
            {selectedId !== null && (
              <div ref={toolbarRef} className="retranslate-toolbar">
                <button className="toolbar-btn" onClick={handleRetry}>
                  Retry
                </button>
                <button
                  className="toolbar-btn"
                  onClick={handleRetryWithFeedback}
                >
                  Retry with feedback
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

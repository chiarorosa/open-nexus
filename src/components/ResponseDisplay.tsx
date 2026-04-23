// ResponseDisplay.tsx — Animated response panel
// Shows LLM/system responses with a typewriter effect.

import { useEffect, useState } from "react";

interface ResponseDisplayProps {
  text: string;
  /** If true, plays the typewriter effect character by character */
  animate?: boolean;
}

export function ResponseDisplay({ text, animate = true }: ResponseDisplayProps) {
  const [displayed, setDisplayed] = useState(animate ? "" : text);
  const [done, setDone] = useState(!animate);

  useEffect(() => {
    if (!animate) {
      setDisplayed(text);
      setDone(true);
      return;
    }

    setDisplayed("");
    setDone(false);

    let i = 0;
    // Adaptive speed: longer text → faster per-char
    const speed = Math.max(8, Math.min(28, Math.floor(2000 / text.length)));

    const timer = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(timer);
        setDone(true);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, animate]);

  if (!text) return null;

  return (
    <div className="response-display" role="region" aria-label="Resposta do Nexus">
      <p className="response-text">
        {displayed}
        {!done && <span className="typewriter-cursor" aria-hidden="true" />}
      </p>
    </div>
  );
}

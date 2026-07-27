import { useState, useCallback } from "react";
import { getFiltererdCommands } from "./filter-commands";

export function useCommandMenu() {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = getFiltererdCommands(query);

  const open = useCallback((text: string) => {
    setQuery(text);
    setIsOpen(true);
    setSelectedIndex(0);
  }, []);

  const updateQuery = useCallback((text: string) => {
    setQuery(text);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const selectAt = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const navigateDown = useCallback(() => {
      setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
    },
    [filtered.length]
  );

  return {
    query,
    isOpen,
    filtered,
    selectedIndex,
    open,
    updateQuery,
    close,
    selectAt,
    navigateUp,
    navigateDown,
  };
}

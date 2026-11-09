import { useCallback, useEffect, useState } from "react";
import { readStorageItem, writeStorageItem } from "../../storage";

const FIRST_RUN_BASE = "tuantuan-first-run";

export function firstRunStorageKey(accountKey: string): string {
  return `${FIRST_RUN_BASE}:${accountKey}`;
}

/**
 * Tracks whether this account has seen the first-run guide.
 * Stored per account so a shared browser does not hide the guide from a new user.
 */
export function useFirstRun(accountKey: string) {
  const [done, setDone] = useState(() => readStorageItem(firstRunStorageKey(accountKey)) === "done");

  useEffect(() => {
    setDone(readStorageItem(firstRunStorageKey(accountKey)) === "done");
  }, [accountKey]);

  const complete = useCallback(() => {
    writeStorageItem(firstRunStorageKey(accountKey), "done");
    setDone(true);
  }, [accountKey]);

  return { shouldShow: !done, complete };
}
